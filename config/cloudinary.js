// Cloudinary configuration
require('dotenv').config();

const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: 'dqaw6rr9m',
    api_key: '813618665743722',
    api_secret: 'DrtWjchXCGRMVKbNv6q4GVwrUbk',
    secure: true
});

module.exports = cloudinary;
