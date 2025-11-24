document.addEventListener('DOMContentLoaded', () => {
    // Hijack all internal links for SPA feel
    document.body.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && link.href.startsWith(window.location.origin) && !link.getAttribute('target')) {
            e.preventDefault();
            const url = link.href;
            
            // Fetch new page content
            fetch(url)
                .then(response => response.text())
                .then(html => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    
                    // Replace Main Content
                    document.querySelector('main').innerHTML = doc.querySelector('main').innerHTML;
                    // Update Title
                    document.title = doc.title;
                    // Update URL without reload
                    history.pushState(null, '', url);
                    
                    // Update Active Tab in Navbar
                    document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
                    const activeLink = document.querySelector(`nav a[href="${link.getAttribute('href')}"]`);
                    if (activeLink) activeLink.classList.add('active');
                });
        }
    });

    // Handle Browser Back Button
    window.addEventListener('popstate', () => {
        location.reload(); // Fallback for back button to ensure scripts run
    });
});
