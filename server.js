const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('./config/cloudinary');

const app = express();
app.use(express.json());

// Настройка multer для загрузки файлов в память
const upload = multer({ storage: multer.memoryStorage() });

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ =====
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:alex69@localhost:5432/sporthub',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
    } else {
        console.log('✅ PostgreSQL подключен успешно!');
        release();
        initDatabase();
    }
});

// ===== ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ =====
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS venues (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                location VARCHAR(255),
                sport VARCHAR(50),
                price INTEGER DEFAULT 0,
                coords_lat DECIMAL(10, 8),
                coords_lng DECIMAL(11, 8),
                image VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS bookings (
                id SERIAL PRIMARY KEY,
                venue_id INTEGER REFERENCES venues(id),
                date DATE NOT NULL,
                time VARCHAR(10) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                user_name VARCHAR(100),
                price INTEGER DEFAULT 0,
                total INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'confirmed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS friendships (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                friend_id INTEGER REFERENCES users(id),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, friend_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                from_id INTEGER REFERENCES users(id),
                to_id INTEGER REFERENCES users(id),
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const venuesCount = await pool.query('SELECT COUNT(*) FROM venues');
        if (venuesCount.rows[0].count === '0') {
            await pool.query(`
                INSERT INTO venues (name, location, sport, price, coords_lat, coords_lng) VALUES
                ('Футбольное поле "Центральное"', 'Москва, ул. Спортивная 1', 'football', 2500, 55.7558, 37.6173),
                ('Баскетбольный зал "Олимп"', 'Москва, ул. Олимпийская 5', 'basketball', 1800, 55.7600, 37.6200),
                ('Теннисный корт "Премиум"', 'Москва, ул. Теннисная 12', 'tennis', 3200, 55.7500, 37.6100),
                ('Волейбольная площадка "Пляж"', 'Москва, ул. Пляжная 3', 'volleyball', 1500, 55.7650, 37.6300),
                ('Бассейн "Волна"', 'Москва, ул. Бассейная 8', 'swimming', 1200, 55.7450, 37.6000)
            `);
            console.log('✅ Тестовые площадки добавлены');
        }

        console.log('✅ База данных инициализирована');
    } catch (error) {
        console.error('❌ Ошибка инициализации базы:', error);
    }
}

// ===== API ЗАГРУЗКИ ИЗОБРАЖЕНИЙ =====

app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'venues' },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            stream.end(req.file.buffer);
        });

        res.json({ 
            success: true, 
            url: result.secure_url,
            public_id: result.public_id
        });
        
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// ===== API ПЛОЩАДОК =====

app.get('/api/venues', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM venues');
        const venues = result.rows.map(v => ({
            ...v,
            coords: [parseFloat(v.coords_lat), parseFloat(v.coords_lng)]
        }));
        res.json(venues);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/venues/:id/slots', async (req, res) => {
    const venueId = parseInt(req.params.id);
    const date = req.query.date;

    try {
        const result = await pool.query(
            'SELECT time FROM bookings WHERE venue_id = $1 AND date = $2 AND status != $3',
            [venueId, date, 'cancelled']
        );

        const bookedTimes = result.rows.map(r => r.time);

        const slots = [];
        for (let hour = 8; hour <= 22; hour++) {
            const time = hour.toString().padStart(2, '0') + ':00';
            slots.push({
                time: time,
                available: !bookedTimes.includes(time)
            });
        }

        res.json(slots);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ===== API БРОНИРОВАНИЯ =====

app.post('/api/bookings', async (req, res) => {
    const { venueId, date, time, phone, userName } = req.body;

    if (!venueId || !date || !time || !phone) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM bookings WHERE venue_id = $1 AND date = $2 AND time = $3 AND status != $4',
            [venueId, date, time, 'cancelled']
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Этот слот уже забронирован' });
        }

        const venueResult = await pool.query('SELECT name, price FROM venues WHERE id = $1', [venueId]);
        if (venueResult.rows.length === 0) {
            return res.status(404).json({ error: 'Площадка не найдена' });
        }

        const venue = venueResult.rows[0];
        const total = venue.price + 150;

        const result = await pool.query(
            `INSERT INTO bookings (venue_id, date, time, phone, user_name, price, total, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed')
             RETURNING *`,
            [venueId, date, time, phone, userName || 'Гость', venue.price, total]
        );

        const booking = result.rows[0];
        booking.venueName = venue.name;

        res.json({ success: true, booking });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/bookings', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).json({ error: 'Укажите телефон' });
    }

    try {
        const result = await pool.query(
            `SELECT b.*, v.name as venue_name
             FROM bookings b
             JOIN venues v ON b.venue_id = v.id
             WHERE b.phone = $1
             ORDER BY b.created_at DESC`,
            [phone]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ===== API АВТОРИЗАЦИИ =====

app.post('/api/register', async (req, res) => {
    const { name, phone, password } = req.body;

    if (!name || !phone || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Пользователь с таким телефоном уже существует' });
        }

        const result = await pool.query(
            'INSERT INTO users (name, phone, password) VALUES ($1, $2, $3) RETURNING id, name, phone',
            [name, phone, password]
        );

        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT id, name, phone FROM users WHERE phone = $1 AND password = $2',
            [phone, password]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Неверный телефон или пароль' });
        }

        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ===== API ДРУЗЕЙ =====

app.get('/api/users/search', async (req, res) => {
    const { query, except } = req.query;

    if (!query) {
        return res.status(400).json({ error: 'Укажите поисковый запрос' });
    }

    try {
        const result = await pool.query(
            `SELECT id, name, phone FROM users
             WHERE id != $1 AND (phone ILIKE $2 OR name ILIKE $2)`,
            [except, `%${query}%`]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/friends/request', async (req, res) => {
    const { userId, friendId } = req.body;

    if (!userId || !friendId || userId === friendId) {
        return res.status(400).json({ error: 'Некорректные данные' });
    }

    try {
        const existing = await pool.query(
            `SELECT id, status FROM friendships
             WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [userId, friendId]
        );

        if (existing.rows.length > 0) {
            const status = existing.rows[0].status;
            if (status === 'accepted') {
                return res.status(409).json({ error: 'Вы уже друзья' });
            }
            return res.status(409).json({ error: 'Заявка уже отправлена' });
        }

        const result = await pool.query(
            'INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, $3) RETURNING *',
            [userId, friendId, 'pending']
        );

        res.json({ success: true, friendship: result.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/friends/requests', async (req, res) => {
    const { userId } = req.query;

    try {
        const result = await pool.query(
            `SELECT f.id, f.created_at, u.id as user_id, u.name
             FROM friendships f
             JOIN users u ON f.user_id = u.id
             WHERE f.friend_id = $1 AND f.status = 'pending'`,
            [userId]
        );

        const requests = result.rows.map(r => ({
            id: r.id,
            user: { id: r.user_id, name: r.name },
            createdAt: r.created_at
        }));

        res.json(requests);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/friends/accept', async (req, res) => {
    const { requestId, userId } = req.body;

    try {
        const result = await pool.query(
            'UPDATE friendships SET status = $1 WHERE id = $2 AND friend_id = $3 RETURNING *',
            ['accepted', requestId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Заявка не найдена' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/friends/reject', async (req, res) => {
    const { requestId, userId } = req.body;

    try {
        const result = await pool.query(
            'DELETE FROM friendships WHERE id = $1 AND friend_id = $2 RETURNING *',
            [requestId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Заявка не найдена' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/friends', async (req, res) => {
    const { userId } = req.query;

    try {
        const result = await pool.query(
            `SELECT
                CASE
                    WHEN f.user_id = $1 THEN f.friend_id
                    ELSE f.user_id
                END as friend_id,
                u.name
             FROM friendships f
             JOIN users u ON u.id = CASE
                 WHEN f.user_id = $1 THEN f.friend_id
                 ELSE f.user_id
             END
             WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'`,
            [userId]
        );

        const friends = result.rows.map(r => ({
            id: r.friend_id,
            name: r.name
        }));

        res.json(friends);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ===== API ЧАТ =====

app.post('/api/messages', async (req, res) => {
    const { fromId, toId, text } = req.body;

    if (!fromId || !toId || !text) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        const areFriends = await pool.query(
            `SELECT id FROM friendships
             WHERE status = 'accepted' AND
             ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))`,
            [fromId, toId]
        );

        if (areFriends.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не являетесь друзьями' });
        }

        const result = await pool.query(
            'INSERT INTO messages (from_id, to_id, text) VALUES ($1, $2, $3) RETURNING *',
            [fromId, toId, text]
        );

        res.json({ success: true, message: result.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/messages', async (req, res) => {
    const { userId, otherId } = req.query;

    try {
        const result = await pool.query(
            `SELECT * FROM messages
             WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
             ORDER BY created_at ASC`,
            [userId, otherId]
        );

        const messages = result.rows.map(m => ({
            ...m,
            fromId: m.from_id,
            toId: m.to_id,
            createdAt: m.created_at
        }));

        res.json(messages);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ===== API АДМИНКИ =====

app.get('/api/admin/venues', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM venues ORDER BY id DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Создание площадки с загрузкой изображения
app.post('/api/admin/venues', upload.single('image'), async (req, res) => {
    const { name, location, sport, price, coords_lat, coords_lng } = req.body;
    
    if (!name || !location || !sport) {
        return res.status(400).json({ error: 'Заполните обязательные поля' });
    }

    try {
        let imageUrl = req.body.image || null;
        
        if (req.file) {
            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: 'venues' },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(req.file.buffer);
            });
            imageUrl = result.secure_url;
        }

        const dbResult = await pool.query(
            `INSERT INTO venues (name, location, sport, price, coords_lat, coords_lng, image)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [name, location, sport, price || 0, coords_lat, coords_lng, imageUrl]
        );
        
        res.json({ success: true, venue: dbResult.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обновление площадки с загрузкой нового изображения
app.put('/api/admin/venues/:id', upload.single('image'), async (req, res) => {
    const venueId = parseInt(req.params.id);
    const { name, location, sport, price, coords_lat, coords_lng } = req.body;

    try {
        let imageUrl = req.body.image;
        
        if (req.file) {
            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: 'venues' },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(req.file.buffer);
            });
            imageUrl = result.secure_url;
        }

        const dbResult = await pool.query(
            `UPDATE venues
             SET name = $1, location = $2, sport = $3, price = $4,
                 coords_lat = $5, coords_lng = $6, image = $7
             WHERE id = $8
             RETURNING *`,
            [name, location, sport, price, coords_lat, coords_lng, imageUrl, venueId]
        );

        if (dbResult.rows.length === 0) {
            return res.status(404).json({ error: 'Площадка не найдена' });
        }

        res.json({ success: true, venue: dbResult.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.delete('/api/admin/venues/:id', async (req, res) => {
    const venueId = parseInt(req.params.id);

    try {
        await pool.query('DELETE FROM bookings WHERE venue_id = $1', [venueId]);
        const result = await pool.query('DELETE FROM venues WHERE id = $1 RETURNING *', [venueId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Площадка не найдена' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ===== СТАТИКА =====

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('=================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 URL: http://localhost:${PORT}`);
    console.log('=================================');
});