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
            // Safely handle empty CC strings
            cc: (process.env.ADMIN_CC && process.env.ADMIN_CC.trim() !== "") 
                ? process.env.ADMIN_CC.split(',') 
                : [], 
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

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'super-secret-key';

// 5. GET Route: List Submissions with Pagination
app.get('/api/submissions', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    
    if (apiKey !== ADMIN_API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    // Get page and limit from query strings (e.g., /api/submissions?page=1&limit=10)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Query to get total count for pagination metadata
    const countSql = "SELECT COUNT(*) as total FROM applications";
    
    db.query(countSql, (countErr, countResult) => {
        if (countErr) return res.status(500).json({ error: countErr.message });

        const totalItems = countResult[0].total;
        const totalPages = Math.ceil(totalItems / limit);

        // Query to get the actual data
        const dataSql = `
            SELECT id, full_name, birthday, contact_number, email_address, id_number, id_photo_path, created_at 
            FROM applications 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `;

        db.execute(dataSql, [limit.toString(), offset.toString()], (err, results) => {
            if (err) return res.status(500).json({ error: err.message });

            res.status(200).json({
                metadata: {
                    total_items: totalItems,
                    total_pages: totalPages,
                    current_page: page,
                    items_per_page: limit
                },
                data: results
            });
        });
    });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Mediko Gateway running on port ${PORT}`);
});