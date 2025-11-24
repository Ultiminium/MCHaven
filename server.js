// ============================================================
// 1. CONFIGURATION & IMPORTS
// ============================================================
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const SALT_ROUNDS = 10;
const SEVEN_DAYS_IN_MS = 7 * 24 * 60 * 60 * 1000;

// Security: Hide tech stack
app.disable('x-powered-by');

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'CHANGE_THIS_TO_A_REALLY_LONG_RANDOM_STRING_12345', // <--- CHANGE THIS IN PRODUCTION
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: SEVEN_DAYS_IN_MS }
}));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Email Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { 
        user: 'spencer@northwinns.com', 
        pass: 'nqbrjapzkkecfpyv' 
    }
});

// ============================================================
// 2. DATABASE CONNECTION & MIGRATIONS
// ============================================================
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error(err.message);
    else console.log("✅ DB Connected.");
    
    db.serialize(() => {
        // Create Tables
        const tables = [
            `CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, password_hash TEXT, 
                role TEXT DEFAULT 'user', pfp_url TEXT, username_last_changed_at TIMESTAMP, status TEXT DEFAULT 'active', 
                termination_reason TEXT, bio TEXT, reset_token TEXT, reset_token_expires TIMESTAMP, reset_attempts INTEGER DEFAULT 0, 
                tos_accepted INTEGER DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, category TEXT, title TEXT, thumbnail_url TEXT, description TEXT, 
                download_url TEXT, credit_url TEXT, supported_versions TEXT, image_url_1 TEXT, image_url_2 TEXT, image_url_3 TEXT, 
                tags TEXT, edition TEXT DEFAULT 'bedrock', rejection_reason TEXT, rejection_advice TEXT, rejection_seen INTEGER DEFAULT 0, 
                is_featured INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS submission_edits (
                id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER, user_id INTEGER, category TEXT, title TEXT, 
                thumbnail_url TEXT, description TEXT, download_url TEXT, credit_url TEXT, supported_versions TEXT, 
                image_url_1 TEXT, image_url_2 TEXT, image_url_3 TEXT, tags TEXT, edition TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER, user_id INTEGER, comment_text TEXT, 
                status TEXT DEFAULT 'visible', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
                FOREIGN KEY(submission_id) REFERENCES submissions(id), FOREIGN KEY(user_id) REFERENCES users(id)
            )`,
            `CREATE TABLE IF NOT EXISTS followers (
                id INTEGER PRIMARY KEY AUTOINCREMENT, follower_id INTEGER, following_id INTEGER, UNIQUE(follower_id, following_id)
            )`,
            `CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, message TEXT, link TEXT, 
                seen INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        ];
        tables.forEach(t => db.run(t));

        // Migrations
        const cols = { 
            submissions: ['user_id','supported_versions','image_url_1','tags','edition','rejection_reason','rejection_seen','is_featured'], 
            users: ['pfp_url','reset_token','bio','status','tos_accepted','termination_reason','reset_attempts'] 
        };
        db.all("PRAGMA table_info(submissions)", (e,r) => { if(r) cols.submissions.forEach(c => { if(!r.some(k=>k.name===c)) db.run(`ALTER TABLE submissions ADD COLUMN ${c} ${c.includes('seen')||c.includes('featured')?'INTEGER DEFAULT 0':'TEXT'}`); })});
        db.all("PRAGMA table_info(users)", (e,r) => { if(r) cols.users.forEach(c => { if(!r.some(k=>k.name===c)) db.run(`ALTER TABLE users ADD COLUMN ${c} ${c.includes('tos')||c.includes('attempts')?'INTEGER DEFAULT 0':'TEXT'}`); })});
    });
});

// ============================================================
// 3. FILE UPLOAD (Sanitized)
// ============================================================
const storage = multer.diskStorage({
    destination: (req, f, cb) => {
        let dest = 'public/thumbnails/';
        if (f.fieldname.includes('Pfp')) dest = 'public/pfps/';
        if (f.fieldname.includes('download')) dest = 'public/downloads/';
        fs.mkdirSync(dest, { recursive: true }); 
        cb(null, dest);
    },
    filename: (req, f, cb) => {
        // FIX: Remove spaces and special chars to prevent broken links
        const safeName = f.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
        cb(null, Date.now() + '-' + safeName);
    }
});
const upload = multer({ storage: storage });

// ============================================================
// 4. GLOBAL MIDDLEWARE (Auth, ToS, Notifications)
// ============================================================
const notify = (uid, msg, link) => db.run("INSERT INTO notifications (user_id, type, message, link) VALUES (?, 'alert', ?, ?)", [uid, msg, link]);

app.use((req, res, next) => {
    if (!req.session.users) req.session.users = {};
    const uid = req.session.activeUserId;
    const user = (uid && req.session.users[uid]) ? req.session.users[uid] : null;
    res.locals = { userRole: user?.role||'guest', userId: user?.id||null, username: user?.username||null, notification: null };

    if (user) {
        db.get("SELECT * FROM users WHERE id=?", [user.id], (err, dbUser) => {
            if (!dbUser) { delete req.session.users[uid]; req.session.activeUserId = null; return next(); }
            
            // Termination Check
            if (dbUser.status === 'terminated') { 
                req.session.destroy(); 
                return res.render('message', { pageTitle:'Banned', type: 'error', title: 'Account Terminated', message: `Reason: ${dbUser.termination_reason}` }); 
            }
            
            // ToS Check
            const safePaths = ['/terms', '/accept-terms', '/logout'];
            if (dbUser.tos_accepted === 0 && !safePaths.includes(req.path) && !req.path.startsWith('/auth/')) {
                return res.redirect('/terms');
            }
            
            // Notification Check
            db.get("SELECT * FROM notifications WHERE user_id=? AND seen=0 ORDER BY created_at DESC LIMIT 1", [user.id], (e, notif) => {
                if (notif) { res.locals.notification = notif; db.run("UPDATE notifications SET seen=1 WHERE id=?", [notif.id]); }
                next();
            });
        });
    } else next();
});

// ============================================================
// 5. AUTHENTICATION (No IP Tracking)
// ============================================================
const loginUser = (req, u) => { 
    if(!req.session.users) req.session.users={}; 
    req.session.users[u.id] = { id:u.id, username:u.username, role:u.role, pfp_url:u.pfp_url }; 
    req.session.activeUserId = u.id; 
};

app.get('/api/user/status', (req, res) => { 
    const uid = req.session.activeUserId; 
    res.json(uid ? { 
        isLoggedIn: true, 
        username: req.session.users[uid].username, 
        role: req.session.users[uid].role, 
        accounts: Object.values(req.session.users).map(u => ({ id: u.id, username: u.username, isActive: u.id == uid })) 
    } : { isLoggedIn: false }); 
});

app.get('/auth/switch/:id', (req, res) => { if (req.session.users[req.params.id]) req.session.activeUserId = req.params.id; res.redirect('back'); });
app.get('/add-account', (req, res) => res.render('login', { pageTitle: 'Add Account' }));
app.get('/logout', (req, res) => { if(req.session.activeUserId) delete req.session.users[req.session.activeUserId]; req.session.activeUserId = Object.keys(req.session.users)[0] || null; res.redirect('/'); });

app.post('/register', upload.single('pfpFile'), async (req, res) => {
    const { username, email, password } = req.body; 
    const pfp = req.file ? `/pfps/${req.file.filename}` : '/pfps/defaults/default.png';
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    
    // Security: Regex for username
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.render('message', {pageTitle:'Error', type:'error', title:'Invalid Username', message:'Letters/Numbers/Underscores only.'});
    
    db.run("INSERT INTO users (username, email, password_hash, pfp_url, tos_accepted) VALUES (?, ?, ?, ?, 0)", [username, email, hash, pfp], function(err) {
        if (err) return res.render('message', {pageTitle:'Error', type:'error', title:'Registration Failed', message:'Username or Email already exists.'});
        loginUser(req, {id:this.lastID, username, role:'user', pfp_url:pfp}); res.redirect('/terms');
    });
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username=? AND email=?", [req.body.username, req.body.email], async (err, u) => {
        if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) return res.render('message', {pageTitle:'Error', type:'error', title:'Login Failed', message:'Invalid credentials.'});
        loginUser(req, u); res.redirect('/');
    });
});

// --- SECURE PASSWORD RESET (Username + Email + 3 Strikes) ---
app.get('/forgot-password', (req, res) => res.render('forgot', { pageTitle: 'Forgot', message: null }));
app.post('/forgot-password', (req, res) => {
    const { username, email } = req.body;
    db.get("SELECT * FROM users WHERE username=? AND email=?", [username, email], (err, user) => {
        if (!user) return res.render('forgot', { pageTitle: 'Forgot', message: 'If credentials match, a code has been sent.' });
        
        const token = crypto.randomInt(100000, 999999).toString();
        db.run("UPDATE users SET reset_token=?, reset_token_expires=?, reset_attempts=0 WHERE id=?", [token, Date.now()+3600000, user.id], () => {
            transporter.sendMail({ from: '"MCHaven Security" <spencer@northwinns.com>', to: email, subject: 'Reset Code', text: `Code: ${token}\nExpires in 1 hour.` });
            res.redirect(`/reset-password?email=${email}`);
        });
    });
});
app.get('/reset-password', (req, res) => res.render('reset', { pageTitle: 'Reset', email: req.query.email||'', message: null }));
app.post('/reset-password', async (req, res) => {
    db.get("SELECT * FROM users WHERE email=?", [req.body.email], async (e, u) => {
        if(!u) return res.render('reset', { pageTitle: 'Reset', email: req.body.email, message: 'Invalid Request' });
        if (u.reset_attempts >= 3) { db.run("UPDATE users SET reset_token=NULL WHERE id=?", [u.id]); return res.render('message', { pageTitle:'Locked', type:'error', title:'Locked', message:'Too many failed attempts.' }); }
        if (u.reset_token !== req.body.code || Date.now() > u.reset_token_expires) {
            db.run("UPDATE users SET reset_attempts = reset_attempts + 1 WHERE id=?", [u.id]);
            return res.render('reset', { pageTitle: 'Reset', email: req.body.email, message: `Invalid Code. (${u.reset_attempts + 1}/3 attempts)` });
        }
        const hash = await bcrypt.hash(req.body.newPassword, SALT_ROUNDS);
        db.run("UPDATE users SET password_hash=?, reset_token=NULL, reset_attempts=0 WHERE id=?", [hash, u.id], () => res.redirect('/login.html?success=PasswordReset'));
    });
});

// ============================================================
// 6. SEARCH & EDITING
// ============================================================
app.get('/search', (req, res) => {
    const { q, edition, category, version, searchType } = req.query;
    if (searchType === 'users') {
        db.all("SELECT * FROM users WHERE username LIKE ? OR bio LIKE ?", [`%${q}%`, `%${q}%`], (e, rows) => res.render('search-results', { pageTitle: 'User Search', query: q, filters: req.query, results: rows || [] }));
    } else {
        let sql = "SELECT * FROM submissions WHERE status='approved'", p = [];
        if (q?.trim()) { sql += " AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)"; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
        if (edition && edition !== 'all') { sql += " AND edition=?"; p.push(edition); }
        if (category && category !== 'all') { sql += " AND category=?"; p.push(category); }
        if (version?.trim()) { sql += " AND supported_versions LIKE ?"; p.push(`%${version}%`); }
        db.all(sql + " ORDER BY submitted_at DESC", p, (e, rows) => res.render('search-results', { pageTitle: 'Results', query: q||'', filters: req.query, results: rows }));
    }
});

app.get('/edit/:id', (req, res) => {
    if(!req.session.activeUserId) return res.redirect('/login.html');
    db.get("SELECT * FROM submissions WHERE id=?", [req.params.id], (e,s) => {
        if(!s || s.user_id !== req.session.activeUserId) return res.render('message', {pageTitle:'Error', type:'error', title:'Error', message:'Unauthorized'});
        res.render('edit', {pageTitle:'Edit Submission', submission:s});
    });
});
app.post('/edit/:id', upload.fields([{ name: 'thumbnailFile', maxCount: 1 }, { name: 'downloadFile', maxCount: 1 }, { name: 'imageFile1', maxCount: 1 }, { name: 'imageFile2', maxCount: 1 }, { name: 'imageFile3', maxCount: 1 }]), (req, res) => {
    if(!req.session.activeUserId) return res.redirect('/login.html');
    db.get("SELECT * FROM submissions WHERE id=?", [req.params.id], (err, cur) => {
        if(!cur || cur.user_id !== req.session.activeUserId) return res.status(403).send("Forbidden");
        const thumb = req.files.thumbnailFile ? `/thumbnails/${req.files.thumbnailFile[0].filename}` : cur.thumbnail_url;
        let dl = req.body.downloadLink || cur.download_url;
        if (req.files.downloadFile) dl = `/downloads/${req.files.downloadFile[0].filename}`;
        const i1 = req.files.imageFile1 ? `/thumbnails/${req.files.imageFile1[0].filename}` : cur.image_url_1;
        const i2 = req.files.imageFile2 ? `/thumbnails/${req.files.imageFile2[0].filename}` : cur.image_url_2;
        const i3 = req.files.imageFile3 ? `/thumbnails/${req.files.imageFile3[0].filename}` : cur.image_url_3;

        db.run(`INSERT INTO submission_edits (submission_id, user_id, category, title, thumbnail_url, description, download_url, credit_url, supported_versions, tags, edition, image_url_1, image_url_2, image_url_3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [req.params.id, req.session.activeUserId, req.body.category, req.body.title, thumb, req.body.description, dl, req.body.credit, req.body.supported_versions, req.body.tags, req.body.edition, i1, i2, i3],
            (err) => res.render('message', {pageTitle:'Success', type:'success', title:'Edit Submitted', message:'Your changes are pending review.'}));
    });
});

// --- SUBMISSIONS ---
app.post('/submit', upload.fields([{ name: 'thumbnailFile', maxCount: 1 }, { name: 'downloadFile', maxCount: 1 }, { name: 'imageFile1', maxCount: 1 }, { name: 'imageFile2', maxCount: 1 }, { name: 'imageFile3', maxCount: 1 }]), (req, res) => {
    if (!req.session.activeUserId) return res.status(401).send("Login.");
    const { category, title, description, downloadLink, credit, supported_versions, tags, edition } = req.body;
    if (category === 'useful' && !['admin','mod'].includes(req.session.users[req.session.activeUserId].role)) return res.status(403).send("Forbidden.");
    
    const thumb = `/thumbnails/${req.files.thumbnailFile[0].filename}`;
    let dl = downloadLink;
    if (req.files.downloadFile) dl = `/downloads/${req.files.downloadFile[0].filename}`;
    const imgs = [req.files.imageFile1, req.files.imageFile2, req.files.imageFile3].map(f => f ? `/thumbnails/${f[0].filename}` : null);
    db.run("INSERT INTO submissions (user_id, category, title, thumbnail_url, description, download_url, credit_url, status, supported_versions, tags, edition, image_url_1, image_url_2, image_url_3) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)", 
        [req.session.activeUserId, category, title, thumb, description, dl, credit, supported_versions, tags, edition || 'bedrock', ...imgs], 
        () => res.render('message', {pageTitle:'Success', type:'success', title:'Submitted', message:'Pending Review.'}));
});

app.post('/submission/delete/:id', (req, res) => {
    if (!req.session.activeUserId) return res.status(401).send("Login.");
    db.get("SELECT user_id FROM submissions WHERE id=?", [req.params.id], (e, s) => {
        if (s && (s.user_id == req.session.activeUserId || ['admin','mod'].includes(req.session.users[req.session.activeUserId].role))) db.run("DELETE FROM submissions WHERE id=?", [req.params.id], ()=>res.redirect('/')); else res.status(403).send("Unauthorized.");
    });
});

// --- ADMIN DASHBOARD & ACTIONS ---
app.get('/admin', (req, res) => {
    if(!req.session.activeUserId || !['admin','mod'].includes(req.session.users[req.session.activeUserId].role)) return res.render('message', {pageTitle:'Error', type:'error', title:'Forbidden', message:'Access Denied'});
    db.all("SELECT * FROM submissions WHERE status='pending' ORDER BY submitted_at DESC", (e,s) => 
    db.all("SELECT e.*, s.title as original_title FROM submission_edits e JOIN submissions s ON e.submission_id = s.id ORDER BY e.created_at DESC", (e,edits) => 
    db.all("SELECT * FROM comments WHERE status='reported'", (e,c) => 
    db.all("SELECT * FROM users WHERE status='reported'", (e,u) => 
    db.all("SELECT * FROM users WHERE role='mod' OR role='admin'", (e,mods) => 
        res.render('admin', {pageTitle:'Admin', submissions:s, pendingEdits:edits, reportedComments:c, reportedUsers:u, staff:mods})))))
    );
});
app.post('/admin/edit/approve/:id', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.get("SELECT * FROM submission_edits WHERE id=?", [req.params.id], (e, edit) => { if(edit) db.run("UPDATE submissions SET category=?, title=?, thumbnail_url=?, description=?, download_url=?, credit_url=?, supported_versions=?, tags=?, edition=?, image_url_1=?, image_url_2=?, image_url_3=? WHERE id=?", [edit.category, edit.title, edit.thumbnail_url, edit.description, edit.download_url, edit.credit_url, edit.supported_versions, edit.tags, edit.edition, edit.image_url_1, edit.image_url_2, edit.image_url_3, edit.submission_id], () => { db.run("DELETE FROM submission_edits WHERE id=?", [req.params.id]); notify(edit.user_id, `Edit to "${edit.title}" Approved!`, `/submission/${edit.submission_id}`); res.redirect('/admin'); }); }); });
app.post('/admin/edit/reject/:id', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.get("SELECT user_id, submission_id, title FROM submission_edits WHERE id=?", [req.params.id], (e, edit) => db.run("DELETE FROM submission_edits WHERE id=?", [req.params.id], () => { notify(edit.user_id, `Edit to "${edit.title}" Rejected.`, `/submission/${edit.submission_id}`); res.redirect('/admin'); })); });
app.post('/admin/approve/:id', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.run("UPDATE submissions SET status='approved', rejection_reason=NULL WHERE id=?", [req.params.id], ()=> { db.get("SELECT user_id,title FROM submissions WHERE id=?",[req.params.id],(e,s)=>notify(s.user_id,`"${s.title}" Approved!`,`/submission/${req.params.id}`)); res.redirect('/admin'); }); });
app.post('/admin/reject/:id', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.run("UPDATE submissions SET status='rejected', rejection_reason=?, rejection_advice=?, rejection_seen=0 WHERE id=?", [req.body.reason, req.body.advice, req.params.id], ()=> { db.get("SELECT user_id,title FROM submissions WHERE id=?",[req.params.id],(e,s)=>notify(s.user_id,`"${s.title}" Rejected.`,`/submission/${req.params.id}`)); res.redirect('/admin'); }); });
app.post('/admin/feature/:id', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.run("UPDATE submissions SET is_featured = CASE WHEN is_featured=1 THEN 0 ELSE 1 END WHERE id=?", [req.params.id], ()=>res.redirect('back')); });
app.post('/admin/terminate/:id', (req, res) => { if(req.session.users[req.session.activeUserId].role==='admin') db.run("UPDATE users SET status='terminated', termination_reason=? WHERE id=?", [req.body.reason, req.params.id], ()=>res.redirect('/admin')); });
app.post('/admin/user/:id/dismiss', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.run("UPDATE users SET status='active' WHERE id=?", [req.params.id], ()=>res.redirect('/admin')); });
app.post('/admin/comment/delete/:id', (req, res) => { if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.run("DELETE FROM comments WHERE id=?", [req.params.id], ()=>res.redirect('/admin')); });

// --- PAGES & PROFILE ---
const renderCat = (c, t, v, req, res) => { const u = req.session.activeUserId, l = 12, p = parseInt(req.query.page)||1, o = (p-1)*l; db.get("SELECT COUNT(id) as t FROM submissions WHERE category=? AND status='approved'", [c], (e,r) => { const q = u ? `SELECT s.* FROM submissions s LEFT JOIN followers f ON s.user_id=f.following_id AND f.follower_id=? WHERE s.category=? AND s.status='approved' ORDER BY CASE WHEN f.follower_id IS NOT NULL THEN 0 ELSE 1 END, s.submitted_at DESC LIMIT ? OFFSET ?` : `SELECT * FROM submissions WHERE category=? AND status='approved' ORDER BY submitted_at DESC LIMIT ? OFFSET ?`; db.all(q, u ? [u,c,l,o] : [c,l,o], (e,rows) => res.render(v, {pageTitle:t, submissions:rows, currentPage:p, totalPages:Math.ceil((r?r.t:0)/l), baseUrl:`/${v}`})); }); };
['texture-pack','addon','skin-pack','world'].forEach(c => app.get(`/${c}s`, (req,res) => renderCat(c, c.split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')+'s', c+'s', req, res)));
app.get('/useful', (req,res) => renderCat('useful', 'Useful', 'useful', req, res)); app.get('/', (req,res) => res.render('index', {pageTitle:'Home'})); app.get('/featured', (req,res) => db.all("SELECT * FROM submissions WHERE is_featured=1 AND status='approved'", (e,rows) => res.render('featured', {pageTitle:'Featured', submissions:rows}))); app.get('/information', (req,res) => res.render('information', {pageTitle:'Info'}));
app.get('/settings', (req,res) => req.session.activeUserId ? db.get("SELECT bio FROM users WHERE id=?", [req.session.activeUserId], (e,u) => res.render('settings', {pageTitle:'Settings', message:req.query.success||req.query.error, messageType:req.query.success?'success':'error', currentUser:u||{}})) : res.redirect('/login.html'));
app.get('/submission', (req,res) => res.render('submission', {pageTitle:'Submit'})); app.get('/register.html', (req,res) => res.render('register', {pageTitle:'Register'})); app.get('/login.html', (req,res) => res.render('login', {pageTitle:'Login'})); app.get('/terms', (req,res) => req.session.activeUserId ? res.render('terms', {pageTitle:'ToS'}) : res.redirect('/login.html')); app.post('/accept-terms', (req,res) => req.session.activeUserId ? db.run("UPDATE users SET tos_accepted=1 WHERE id=?", [req.session.activeUserId], ()=>res.redirect('/')) : res.redirect('/login.html'));
app.get('/submission/:id', (req, res) => { db.get("SELECT * FROM submissions WHERE id=?", [req.params.id], (e,s) => { if(!s) return res.status(404).send("Not found"); const o = s.user_id === req.session.activeUserId; if(s.status !== 'approved' && !o && !['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) return res.status(404).send("Not found"); if(o && s.status === 'rejected' && s.rejection_seen === 0) db.run("UPDATE submissions SET rejection_seen = 1 WHERE id = ?", [s.id]); db.all("SELECT c.*, u.username, u.pfp_url FROM comments c JOIN users u ON c.user_id=u.id WHERE c.submission_id=? ORDER BY c.created_at DESC", [req.params.id], (e,c) => res.render('detail', {pageTitle:s.title, submission:s, comments:c})); }); });
app.get('/profile/:username', (req, res) => db.get("SELECT * FROM users WHERE username=?", [req.params.username], (e,u) => u ? db.all((u.id===req.session.activeUserId)?"SELECT * FROM submissions WHERE user_id=? ORDER BY submitted_at DESC":"SELECT * FROM submissions WHERE user_id=? AND status='approved' ORDER BY submitted_at DESC", [u.id], (e,s) => res.render('profile', {pageTitle:u.username, profileUser:u, submissions:s, followerCount:0, isFollowing:false})) : res.status(404).send("Not Found")));
const checkAuth = (req,res,next) => req.session.activeUserId ? next() : res.redirect('/login.html');
const checkAdmin = (req,res,next) => req.session.users[req.session.activeUserId]?.role === 'admin' ? next() : res.status(403).send("No");
app.post('/submission/:id/comment', checkAuth, (req,res) => db.run("INSERT INTO comments (submission_id, user_id, comment_text) VALUES (?, ?, ?)", [req.params.id, req.session.activeUserId, req.body.comment_text], ()=>res.redirect(`/submission/${req.params.id}`)));
app.post('/comment/:id/report', checkAuth, (req,res) => db.run("UPDATE comments SET status='reported' WHERE id=?", [req.params.id], ()=>res.redirect('back')));
app.post('/comment/:id/delete', (req,res) => (['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) ? db.run("DELETE FROM comments WHERE id=?", [req.params.id], ()=>res.redirect('back')) : res.status(403).send("No"));
app.post('/profile/:username/follow', checkAuth, (req,res) => db.get("SELECT id FROM users WHERE username=?",[req.params.username],(e,u)=> u && db.run("INSERT INTO followers (follower_id,following_id) VALUES (?,?)",[req.session.activeUserId,u.id],()=>res.redirect('back'))));
app.post('/profile/:username/unfollow', checkAuth, (req,res) => db.get("SELECT id FROM users WHERE username=?",[req.params.username],(e,u)=> u && db.run("DELETE FROM followers WHERE follower_id=? AND following_id=?",[req.session.activeUserId,u.id],()=>res.redirect('back'))));
app.post('/profile/:username/report', checkAuth, (req,res) => db.run("UPDATE users SET status='reported' WHERE username=?",[req.params.username],()=>res.redirect('back')));
app.post('/profile/:username/promote', checkAdmin, (req,res) => db.run("UPDATE users SET role='mod' WHERE username=?",[req.params.username],()=>res.redirect('back')));
app.post('/profile/:username/demote', checkAdmin, (req,res) => db.run("UPDATE users SET role='user' WHERE username=?",[req.params.username],()=>res.redirect('back')));
app.post('/settings/pfp', upload.single('newPfpFile'), checkAuth, (req,res) => req.file ? db.run("UPDATE users SET pfp_url=? WHERE id=?", [`/pfps/${req.file.filename}`, req.session.activeUserId], ()=>res.redirect('/settings.html?success=PfpUpdated')) : res.redirect('/settings.html'));
app.post('/settings/bio', checkAuth, (req,res) => db.run("UPDATE users SET bio=? WHERE id=?", [req.body.bio, req.session.activeUserId], ()=>res.redirect('/settings.html?success=BioUpdated')));
app.post('/settings/username', checkAuth, (req,res) => db.get("SELECT id FROM users WHERE username=?", [req.body.newUsername], (e,ex) => ex ? res.redirect('/settings.html?error=Taken') : db.run("UPDATE users SET username=? WHERE id=?", [req.body.newUsername, req.session.activeUserId], ()=>res.redirect('/settings.html?success=Updated'))));
app.get('/download-redirect', (req, res) => res.render('redirect', { downloadUrl: req.query.url, pageTitle: 'Download' }));

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
