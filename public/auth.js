document.addEventListener('DOMContentLoaded', () => {
    const headerRight = document.querySelector('#header-right-container');
    const donateButtonHTML = `<button id="openDonateBtn" class="donate-btn-header">Donate</button>`;

    fetch('/api/user/status')
        .then(response => response.json())
        .then(data => {
            if (data.isLoggedIn) {
                // Generate Accounts List HTML
                let accountsHTML = '';
                if (data.accounts && data.accounts.length > 0) {
                    accountsHTML = data.accounts.map(acc => `
                        <a href="/auth/switch/${acc.id}" style="${acc.isActive ? 'font-weight:bold; color:var(--accent-primary);' : ''}">
                            ${acc.username}
                        </a>
                    `).join('');
                }
                accountsHTML += `<hr style="margin:5px 0; border:0; border-top:1px solid #555;"><a href="/add-account">Add Account +</a>`;

                headerRight.innerHTML = `
                    ${donateButtonHTML}
                    <a href="/submission" class="submit-button-special">SUBMIT</a>
                    
                    <form action="/search" method="GET" class="search-form">
                        <input type="search" name="q" placeholder="Search..." required>
                        <button type="submit">🔍</button>
                    </form>

                    <div class="dropdown" style="position: relative; display: inline-block;">
                        <button class="button" style="display:flex; align-items:center; gap:0.5rem;">
                            ${data.username} ▼
                        </button>
                        <div class="dropdown-content" style="display: none; position: absolute; right: 0; background-color: var(--bg-secondary); min-width: 160px; box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2); z-index: 1; border: 1px solid var(--border-color); border-radius: 5px;">
                            <a href="/profile/${data.username}">My Profile</a>
                            <hr style="margin:5px 0; border:0; border-top:1px solid #555;">
                            <div style="padding: 5px 16px; color: var(--text-secondary); font-size: 0.8rem;">Switch Account:</div>
                            ${accountsHTML}
                            <hr style="margin:5px 0; border:0; border-top:1px solid #555;">
                            <a href="/logout">Log out</a>
                        </div>
                    </div>
                `;

                // Dropdown Logic
                const dropBtn = headerRight.querySelector('.dropdown button');
                const dropContent = headerRight.querySelector('.dropdown-content');
                dropBtn.addEventListener('click', (e) => { e.stopPropagation(); dropContent.style.display = dropContent.style.display === 'block' ? 'none' : 'block'; });
                window.addEventListener('click', () => { dropContent.style.display = 'none'; });

            } else {
                headerRight.innerHTML = `
                    ${donateButtonHTML}
                    <form action="/search" method="GET" class="search-form">
                        <input type="search" name="q" placeholder="Search..." required>
                        <button type="submit">🔍</button>
                    </form>
                    <a href="/login.html" class="button">LOGIN</a>
                    <a href="/register.html" class="button">REGISTER</a>
                `;
            }

            // Modal Logic
            const modal = document.getElementById("donationModal");
            const btn = document.getElementById("openDonateBtn");
            const span = document.getElementsByClassName("close-modal")[0];
            if (btn && modal) {
                btn.onclick = () => modal.style.display = "block";
                if(span) span.onclick = () => modal.style.display = "none";
                window.onclick = (e) => { if (e.target == modal) modal.style.display = "none"; }
            }
        })
        .catch(error => console.error("Error fetching auth status:", error));
});
