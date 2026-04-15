require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configure Local Storage for IDs
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, `ID-${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// 2. MySQL Connection
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// 3. Brevo (formerly Sendinblue) SMTP Transporter
const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_PASS
    }
});

// 4. POST Route: Receive Application
app.post('/api/apply', upload.array('id_photos', 2), (req, res) => {
    const { full_name, birthday, contact_number, email_address, id_number } = req.body;
    const photoPaths = req.files.map(f => f.path).join(',');

    const sql = `INSERT INTO applications (full_name, birthday, contact_number, email_address, id_number, id_photo_path) VALUES (?, ?, ?, ?, ?, ?)`;
    
    db.execute(sql, [full_name, birthday, contact_number, email_address, id_number, photoPaths], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        // SEND EMAILS
        const mailOptionsAdmin = {
            from: '"Mediko Gateway" <no-reply@mediko.ph>',
            to: 'admin@mediko.ph',
            subject: 'New Senior/PWD Application - Mediko.ph',
            text: `New application from ${full_name}. ID Number: ${id_number}`,
            attachments: req.files.map(f => ({ path: f.path }))
        };

        const mailOptionsUser = {
            from: '"Mediko.ph" <no-reply@mediko.ph>',
            to: email_address,
            subject: 'Application Received',
            text: `Hi ${full_name}, we have received your Senior/PWD application. Please allow 5 business days for review.`
        };

        transporter.sendMail(mailOptionsAdmin);
        transporter.sendMail(mailOptionsUser);

        res.status(200).json({ success: true, message: 'Application submitted!' });
    });
});

app.listen(3001, () => console.log('Gateway running on port 3000'));