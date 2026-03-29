// Cloudinary configuration
require('dotenv').config();

const cloudinary = require('cloudinary').v2;

cloudinary.config({
    secure: true
});

module.exports = cloudinary;
