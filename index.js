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

// 3. Brevo SMTP Transporter
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
    
    // Safely handle photo paths for DB
    const photoPaths = req.files ? req.files.map(f => f.path).join(',') : '';

    const sql = `INSERT INTO applications (full_name, birthday, contact_number, email_address, id_number, id_photo_path) VALUES (?, ?, ?, ?, ?, ?)`;
    
    db.execute(sql, [full_name, birthday, contact_number, email_address, id_number, photoPaths], (err, result) => {
        if (err) {
            console.error("Database Error:", err.message);
            return res.status(500).json({ error: err.message });
        }

        // PREPARE ATTACHMENTS FOR ADMIN
        const attachments = req.files ? req.files.map(f => ({
            filename: f.filename,
            path: f.path
        })) : [];

        // SEND EMAILS
        const mailOptionsAdmin = {
            from: '"Mediko Gateway" <no-reply@mediko.ph>',
            to: process.env.ADMIN_EMAIL,
            cc: process.env.ADMIN_CC ? process.env.ADMIN_CC.split(',') : [], // Split string into array for CC
            subject: `New Senior/PWD Application: ${full_name}`,
            text: `New application received.\n\nName: ${full_name}\nID Number: ${id_number}\nBirthday: ${birthday}\nContact: ${contact_number}\nEmail: ${email_address}`,
            attachments: attachments
        };

        const mailOptionsUser = {
            from: '"Mediko.ph" <no-reply@mediko.ph>',
            to: email_address,
            subject: 'Application Received - Mediko.ph',
            text: `Hi ${full_name},\n\nWe have received your Senior/PWD application. Please allow 5 business days for review.\n\nThank you!`
        };

        // Fire and forget (or use try/catch if you want to log errors)
        transporter.sendMail(mailOptionsAdmin).catch(e => console.error("Admin Mail Error:", e));
        transporter.sendMail(mailOptionsUser).catch(e => console.error("User Mail Error:", e));

        res.status(200).json({ 
            success: true, 
            message: 'Application submitted successfully!',
            id: result.insertId 
        });
    });
});

app.listen(3001, () => console.log('Mediko Gateway running on port 3001'));