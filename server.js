// 1. Import Packages
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');

// 2. Setup
const app = express();
const PORT = 3000;
const saltRounds = 10;
const SEVEN_DAYS_IN_MS = 7 * 24 * 60 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'super-secret-key-123',
    resave: false,
    saveUninitialized: false,
}));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'spencer@northwinns.com', pass: 'nqbrjapzkkecfpyv' }
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// 3. Database
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error(err.message);
    else console.log("✅ DB Connected.");
    db.serialize(() => {
        const tables = [
            `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'user', pfp_url TEXT, username_last_changed_at TIMESTAMP, status TEXT DEFAULT 'active', bio TEXT, reset_token TEXT, reset_token_expires TIMESTAMP, tos_accepted INTEGER DEFAULT 0)`,
            `CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, category TEXT, title TEXT, thumbnail_url TEXT, description TEXT, download_url TEXT, credit_url TEXT, supported_versions TEXT, image_url_1 TEXT, image_url_2 TEXT, image_url_3 TEXT, tags TEXT, edition TEXT DEFAULT 'bedrock', rejection_reason TEXT, rejection_advice TEXT, rejection_seen INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
            `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER, user_id INTEGER, comment_text TEXT, status TEXT DEFAULT 'visible', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(submission_id) REFERENCES submissions(id), FOREIGN KEY(user_id) REFERENCES users(id))`,
            `CREATE TABLE IF NOT EXISTS followers (id INTEGER PRIMARY KEY AUTOINCREMENT, follower_id INTEGER, following_id INTEGER, UNIQUE(follower_id, following_id))`
        ];
        tables.forEach(t => db.run(t));
        const cols = { submissions: ['user_id','supported_versions','image_url_1','tags','edition','rejection_reason','rejection_advice','rejection_seen'], users: ['pfp_url','reset_token','bio','status','tos_accepted'] };
        db.all("PRAGMA table_info(submissions)", (e,r) => { if(r) cols.submissions.forEach(c => { if(!r.some(k=>k.name===c)) db.run(`ALTER TABLE submissions ADD COLUMN ${c} ${c.includes('seen')?'INTEGER DEFAULT 0':'TEXT'}`); })});
        db.all("PRAGMA table_info(users)", (e,r) => { if(r) cols.users.forEach(c => { if(!r.some(k=>k.name===c)) db.run(`ALTER TABLE users ADD COLUMN ${c} ${c.includes('tos')?'INTEGER DEFAULT 0':'TEXT'}`); })});
    });
});

const storage = multer.diskStorage({
    destination: (req, f, cb) => { fs.mkdirSync(f.fieldname.includes('Pfp') ? 'public/pfps/' : 'public/thumbnails/', { recursive: true }); cb(null, f.fieldname.includes('Pfp') ? 'public/pfps/' : 'public/thumbnails/'); },
    filename: (req, f, cb) => cb(null, Date.now() + '-' + f.originalname)
});
const upload = multer({ storage: storage });

// --- CRITICAL MIDDLEWARE FIX (Issue 2 Fix) ---
app.use((req, res, next) => {
    if (!req.session.users) req.session.users = {};
    const uid = req.session.activeUserId;
    const user = (uid && req.session.users[uid]) ? req.session.users[uid] : null;
    res.locals = { userRole: user?.role||'guest', userId: user?.id||null, username: user?.username||null, notification: null };

    if (user) {
        db.get("SELECT * FROM users WHERE id=?", [user.id], (err, dbUser) => {
            if (!dbUser) { delete req.session.users[uid]; req.session.activeUserId = null; return next(); }
            
            // Check for ToS (Redirect if needed)
            if (dbUser.tos_accepted === 0 && !['/terms', '/accept-terms', '/logout'].includes(req.path) && !req.path.startsWith('/auth/')) {
                return res.redirect('/terms');
            }

            // ALWAYS Check for Rejections (Even if ToS just accepted)
            db.get("SELECT id, title FROM submissions WHERE user_id=? AND status='rejected' AND rejection_seen=0 LIMIT 1", [user.id], (e, sub) => {
                if (sub) {
                    res.locals.notification = { 
                        type: 'rejection', 
                        message: `Your submission "${sub.title}" was rejected.`, 
                        link: `/submission/${sub.id}` 
                    };
                }
                next();
            });
        });
    } else next();
});

// --- AUTH ---
const loginUser = (req, u) => { if(!req.session.users) req.session.users={}; req.session.users[u.id]={id:u.id, username:u.username, role:u.role, pfp_url:u.pfp_url}; req.session.activeUserId=u.id; };
app.get('/api/user/status', (req, res) => { const uid = req.session.activeUserId; res.json(uid ? { isLoggedIn: true, username: req.session.users[uid].username, role: req.session.users[uid].role, accounts: Object.values(req.session.users).map(u => ({ id: u.id, username: u.username, isActive: u.id == uid })) } : { isLoggedIn: false }); });
app.get('/auth/switch/:id', (req, res) => { if (req.session.users[req.params.id]) req.session.activeUserId = req.params.id; res.redirect('back'); });
app.get('/add-account', (req, res) => res.render('login', { pageTitle: 'Add Account' }));
app.get('/logout', (req, res) => { if(req.session.activeUserId) delete req.session.users[req.session.activeUserId]; req.session.activeUserId = Object.keys(req.session.users)[0] || null; res.redirect('/'); });
app.post('/register', upload.single('pfpFile'), async (req, res) => {
    const { username, email, password } = req.body; const pfp = req.file ? `/pfps/${req.file.filename}` : '/pfps/defaults/default.png';
    const hash = await bcrypt.hash(password, saltRounds);
    db.run("INSERT INTO users (username, email, password_hash, pfp_url, tos_accepted) VALUES (?, ?, ?, ?, 0)", [username, email, hash, pfp], function(err) {
        if (err) return res.status(409).send("User exists."); loginUser(req, {id:this.lastID, username, role:'user', pfp_url:pfp}); res.redirect('/terms');
    });
});
app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username=? AND email=?", [req.body.username, req.body.email], async (err, u) => {
        if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) return res.status(401).send("Invalid.");
        loginUser(req, u); res.redirect('/');
    });
});
app.get('/forgot-password', (req, res) => res.render('forgot', { pageTitle: 'Forgot', message: null }));
app.post('/forgot-password', (req, res) => {
    db.get("SELECT * FROM users WHERE email=?", [req.body.email], (e, u) => {
        if(!u) return res.render('forgot', { pageTitle: 'Forgot', message: 'Code sent if email exists.' });
        const token = Math.floor(100000+Math.random()*900000).toString();
        db.run("UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?", [token, Date.now()+3600000, u.id], () => {
            transporter.sendMail({ from: '"MCHaven Support" <spencer@northwinns.com>', to: req.body.email, subject: 'Reset Code', text: `Code: ${token}` });
            res.redirect(`/reset-password?email=${req.body.email}`);
        });
    });
});
app.get('/reset-password', (req, res) => res.render('reset', { pageTitle: 'Reset', email: req.query.email||'', message: null }));
app.post('/reset-password', async (req, res) => {
    db.get("SELECT * FROM users WHERE email=?", [req.body.email], async (e, u) => {
        if(!u || u.reset_token !== req.body.code || Date.now() > u.reset_token_expires) return res.render('reset', { pageTitle: 'Reset', email:req.body.email, message: 'Invalid Code' });
        const hash = await bcrypt.hash(req.body.newPassword, saltRounds);
        db.run("UPDATE users SET password_hash=?, reset_token=NULL WHERE id=?", [hash, u.id], () => res.redirect('/login.html?success=PasswordReset'));
    });
});

// --- SEARCH ---
app.get('/search', (req, res) => {
    const { q, edition, category, version, searchType } = req.query;
    if (searchType === 'users') {
        if (!q?.trim()) return res.render('search-results', { pageTitle: 'User Search', query: '', filters: { edition:'all', category:'all', version:'', searchType:'users' }, results: [] });
        db.all("SELECT * FROM users WHERE username LIKE ? OR bio LIKE ?", [`%${q}%`, `%${q}%`], (e, rows) => res.render('search-results', { pageTitle: 'User Search', query: q, filters: { edition:'all', category:'all', version:'', searchType:'users' }, results: rows }));
    } else {
        let sql = "SELECT * FROM submissions WHERE status='approved'", p = [];
        if (q?.trim()) { sql += " AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)"; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
        if (edition && edition !== 'all') { sql += " AND edition=?"; p.push(edition); }
        if (category && category !== 'all') { sql += " AND category=?"; p.push(category); }
        if (version?.trim()) { sql += " AND supported_versions LIKE ?"; p.push(`%${version}%`); }
        db.all(sql + " ORDER BY submitted_at DESC", p, (e, rows) => res.render('search-results', { pageTitle: 'Results', query: q||'', filters: { edition:edition||'all', category:category||'all', version:version||'', searchType:'content' }, results: rows }));
    }
});
const renderCat = (cat, title, view, req, res) => {
    const uid = req.session.activeUserId, limit = 12, page = parseInt(req.query.page)||1, off = (page-1)*limit;
    db.get("SELECT COUNT(id) as t FROM submissions WHERE category=? AND status='approved'", [cat], (e,r) => {
        const sql = uid ? `SELECT s.* FROM submissions s LEFT JOIN followers f ON s.user_id=f.following_id AND f.follower_id=? WHERE s.category=? AND s.status='approved' ORDER BY CASE WHEN f.follower_id IS NOT NULL THEN 0 ELSE 1 END, s.submitted_at DESC LIMIT ? OFFSET ?` : `SELECT * FROM submissions WHERE category=? AND status='approved' ORDER BY submitted_at DESC LIMIT ? OFFSET ?`;
        db.all(sql, uid ? [uid,cat,limit,off] : [cat,limit,off], (e,rows) => res.render(view, {pageTitle:title, submissions:rows, currentPage:page, totalPages:Math.ceil((r?r.t:0)/limit), baseUrl:`/${view}.html`}));
    });
};
['texture-pack','addon','skin-pack','world','useful'].forEach(c => app.get(`/${c}s.html`, (req,res) => renderCat(c, c.charAt(0).toUpperCase()+c.slice(1).replace('-',' ')+'s', c+'s', req, res)));
app.get('/useful.html', (req,res) => renderCat('useful', 'Useful', 'useful', req, res));
app.get('/', (req,res) => res.render('index', {pageTitle:'Home'})); app.get('/index.html', (req,res) => res.redirect('/'));
app.get('/information.html', (req,res) => res.render('information', {pageTitle:'Info'}));
app.get('/settings.html', (req,res) => req.session.activeUserId ? db.get("SELECT bio FROM users WHERE id=?", [req.session.activeUserId], (e,u) => res.render('settings', {pageTitle:'Settings', message:req.query.success||req.query.error, messageType:req.query.success?'success':'error', currentUser:u||{}})) : res.redirect('/login.html'));
app.get('/submission.html', (req,res) => res.render('submission', {pageTitle:'Submit'})); app.get('/register.html', (req,res) => res.render('register', {pageTitle:'Register'})); app.get('/login.html', (req,res) => res.render('login', {pageTitle:'Login'}));
app.get('/terms', (req,res) => req.session.activeUserId ? res.render('terms', {pageTitle:'ToS'}) : res.redirect('/login.html'));
app.post('/accept-terms', (req,res) => req.session.activeUserId ? db.run("UPDATE users SET tos_accepted=1 WHERE id=?", [req.session.activeUserId], ()=>res.redirect('/')) : res.redirect('/login.html'));

// --- SUBMISSIONS & DETAIL ---
app.post('/submit', upload.fields([{ name: 'thumbnailFile', maxCount: 1 }, { name: 'downloadFile', maxCount: 1 }, { name: 'imageFile1', maxCount: 1 }, { name: 'imageFile2', maxCount: 1 }, { name: 'imageFile3', maxCount: 1 }]), (req, res) => {
    if (!req.session.activeUserId) return res.status(401).send("Login.");
    const { category, title, description, downloadLink, credit, supported_versions, tags, edition } = req.body;
    if (category === 'useful' && !['admin','mod'].includes(req.session.users[req.session.activeUserId].role)) return res.status(403).send("Forbidden.");
    const thumb = `/thumbnails/${req.files.thumbnailFile[0].filename}`;
    let dl = downloadLink;
    if (req.files.downloadFile) {
        const ext = path.extname(req.files.downloadFile[0].originalname).toLowerCase();
        const valid = (category === 'useful') || (edition === 'java' && ['.jar','.zip'].includes(ext)) || (edition !== 'java' && { 'texture-pack': ['.mcpack','.zip'], 'addon': ['.mcaddon','.zip'], 'skin-pack': ['.png','.mcpack'], 'world': ['.mcworld','.zip'] }[category]?.includes(ext));
        if (!valid) return res.status(400).send("Invalid file.");
        dl = `/downloads/${req.files.downloadFile[0].filename}`;
    }
    const imgs = [req.files.imageFile1, req.files.imageFile2, req.files.imageFile3].map(f => f ? `/thumbnails/${f[0].filename}` : null);
    db.run("INSERT INTO submissions (user_id, category, title, thumbnail_url, description, download_url, credit_url, status, supported_versions, tags, edition, image_url_1, image_url_2, image_url_3) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)", 
        [req.session.activeUserId, category, title, thumb, description, dl, credit, supported_versions, tags, edition || 'bedrock', ...imgs], () => res.send("<h1>Submitted!</h1><a href='/'>Home</a>"));
});
app.get('/submission/:id', (req, res) => {
    db.get("SELECT * FROM submissions WHERE id=?", [req.params.id], (e,s) => {
        if(!s) return res.status(404).send("Not found");
        const isOwner = s.user_id === req.session.activeUserId;
        if(s.status !== 'approved' && !isOwner && !['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) return res.status(404).send("Not found");
        if(isOwner && s.status === 'rejected' && s.rejection_seen === 0) db.run("UPDATE submissions SET rejection_seen = 1 WHERE id = ?", [s.id]);
        db.all("SELECT c.*, u.username, u.pfp_url FROM comments c JOIN users u ON c.user_id=u.id WHERE c.submission_id=? ORDER BY c.created_at DESC", [req.params.id], (e,c) => res.render('detail', {pageTitle:s.title, submission:s, comments:c}));
    });
});
app.post('/submission/delete/:id', (req, res) => {
    if (!req.session.activeUserId) return res.status(401).send("Login.");
    db.get("SELECT user_id FROM submissions WHERE id = ?", [req.params.id], (e, s) => {
        if (s && (s.user_id == req.session.activeUserId || ['admin','mod'].includes(req.session.users[req.session.activeUserId].role))) db.run("DELETE FROM submissions WHERE id=?", [req.params.id], ()=>res.redirect('/')); else res.status(403).send("Unauthorized.");
    });
});

// --- ADMIN & ACTIONS (Issue 1 Fix) ---
app.get('/admin', (req, res) => {
    if(!req.session.activeUserId || !['admin','mod'].includes(req.session.users[req.session.activeUserId].role)) return res.status(403).send("Forbidden");
    db.all("SELECT * FROM submissions WHERE status='pending' ORDER BY submitted_at DESC", (e,s) => db.all("SELECT * FROM comments WHERE status='reported'", (e,c) => db.all("SELECT * FROM users WHERE status='reported'", (e,u) => res.render('admin', {pageTitle:'Admin', submissions:s, reportedComments:c, reportedUsers:u}))));
});
app.post('/admin/approve/:id', (req, res) => {
    if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) db.run("UPDATE submissions SET status='approved', rejection_reason=NULL, rejection_advice=NULL WHERE id=?", [req.params.id], ()=>res.redirect('/admin'));
});
// REJECT FIX: Explicit redirect back to /admin after DB update
app.post('/admin/reject/:id', (req, res) => {
    if(['admin','mod'].includes(req.session.users[req.session.activeUserId]?.role)) {
        db.run("UPDATE submissions SET status='rejected', rejection_reason=?, rejection_advice=?, rejection_seen=0 WHERE id=?", [req.body.reason, req.body.advice, req.params.id], (err) => {
            res.redirect('/admin');
        });
    } else { res.status(403).send("No"); }
});
app.post('/admin/comment/delete/:id', (req, res) => db.run("DELETE FROM comments WHERE id=?", [req.params.id], ()=>res.redirect('/admin')));
app.post('/admin/user/:id/dismiss', (req, res) => db.run("UPDATE users SET status='active' WHERE id=?", [req.params.id], ()=>res.redirect('/admin')));

// Profile & Settings Actions
const checkAuth = (req,res,next) => req.session.activeUserId ? next() : res.redirect('/login.html');
const checkAdmin = (req,res,next) => req.session.users[req.session.activeUserId]?.role === 'admin' ? next() : res.status(403).send("No");
app.get('/profile/:username', (req, res) => {
    db.get("SELECT * FROM users WHERE username=?", [req.params.username], (e,u) => {
        if(!u) return res.status(404).send("Not Found");
        const sql = (u.id === req.session.activeUserId) ? "SELECT * FROM submissions WHERE user_id=? ORDER BY submitted_at DESC" : "SELECT * FROM submissions WHERE user_id=? AND status='approved' ORDER BY submitted_at DESC";
        db.all(sql, [u.id], (e,s) => db.get("SELECT COUNT(id) as c FROM followers WHERE following_id=?", [u.id], (e,f) => db.get("SELECT id FROM followers WHERE follower_id=? AND following_id=?", [req.session.activeUserId, u.id], (e,fol) => res.render('profile', {pageTitle:u.username, profileUser:u, submissions:s, followerCount:f?f.c:0, isFollowing:!!fol}))));
    });
});
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
app.post('/settings/username', checkAuth, (req,res) => {
    db.get("SELECT id FROM users WHERE username=?", [req.body.newUsername], (e,ex) => { if(ex) return res.redirect('/settings.html?error=UsernameTaken'); db.get("SELECT username_last_changed_at FROM users WHERE id=?", [req.session.activeUserId], (e,u) => { if(req.session.users[req.session.activeUserId].role !== 'admin' && u.username_last_changed_at && Date.now()-new Date(u.username_last_changed_at).getTime() < SEVEN_DAYS_IN_MS) return res.redirect('/settings.html?error=UsernameCooldown'); db.run("UPDATE users SET username=?, username_last_changed_at=CURRENT_TIMESTAMP WHERE id=?", [req.body.newUsername, req.session.activeUserId], ()=>res.redirect('/settings.html?success=UsernameUpdated')); }); });
});
app.get('/download-redirect', (req, res) => res.render('redirect', { downloadUrl: req.query.url, pageTitle: 'Download' }));
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
