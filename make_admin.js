const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');

const usernameToPromote = 'moaca'; 

console.log(`Attempting to promote user: ${usernameToPromote}...`);

db.serialize(() => {
    // 1. Check if user exists
    db.get("SELECT id, role FROM users WHERE username = ?", [usernameToPromote], (err, row) => {
        if (err) {
            console.error("Error:", err.message);
            return;
        }
        
        if (!row) {
            console.error(`❌ User '${usernameToPromote}' not found! Check spelling.`);
            return;
        }

        console.log(`Found user. Current role: ${row.role}`);

        // 2. Force update to admin
        db.run("UPDATE users SET role = 'admin' WHERE username = ?", [usernameToPromote], function(err) {
            if (err) {
                console.error("Update failed:", err.message);
            } else {
                console.log(`✅ SUCCESS! '${usernameToPromote}' is now an ADMIN.`);
            }
        });
    });
});
