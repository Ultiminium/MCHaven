document.addEventListener('DOMContentLoaded', () => {
    const applySettings = () => {
        const savedTheme = localStorage.getItem('themeColor') || 'default';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const customAccentColor = localStorage.getItem('customThemeColor');
        if (customAccentColor) {
            document.documentElement.style.setProperty('--accent-primary', customAccentColor);
            document.documentElement.style.setProperty('--border-color', customAccentColor);
        } else {
            document.documentElement.style.removeProperty('--accent-primary');
            document.documentElement.style.removeProperty('--border-color');
        }

        const savedLayout = localStorage.getItem('displayLayout') || 'grid';
        const mainContent = document.querySelector('main');
        if (mainContent) {
            mainContent.setAttribute('data-layout', savedLayout);
        }

        if (document.body.id === 'settings-page') {
            document.querySelectorAll('.theme-button').forEach(button => {
                button.classList.toggle('active', button.dataset.theme === savedTheme);
            });
            const layoutRadio = document.querySelector(`input[name="layout"][value="${savedLayout}"]`);
            if (layoutRadio) {
                layoutRadio.checked = true;
            }
            if (customAccentColor) {
                document.getElementById('custom-color-input').value = customAccentColor;
            }
        }
    };

    const changeTheme = (theme) => {
        localStorage.removeItem('customThemeColor');
        localStorage.setItem('themeColor', theme);
        applySettings();
    };

    const changeLayout = (layout) => {
        localStorage.setItem('displayLayout', layout);
        const mainContent = document.querySelector('main');
        if (mainContent) {
            mainContent.setAttribute('data-layout', layout);
        }
    };

    if (document.body.id === 'settings-page') {
        document.querySelectorAll('.theme-button').forEach(button => {
            button.addEventListener('click', () => changeTheme(button.dataset.theme));
        });

        document.querySelectorAll('input[name="layout"]').forEach(radio => {
            radio.addEventListener('change', (event) => changeLayout(event.target.value));
        });

        const customColorInput = document.getElementById('custom-color-input');
        const setCustomColorBtn = document.getElementById('set-custom-color-btn');

        if (setCustomColorBtn) {
            setCustomColorBtn.addEventListener('click', () => {
                const newColor = customColorInput.value;
                if (/^#[0-9A-F]{6}$/i.test(newColor)) {
                    localStorage.setItem('customThemeColor', newColor);
                    applySettings();
                } else {
                    alert('Please enter a valid 6-digit hex code (e.g., #FF5733)');
                }
            });
        }
    }

    applySettings();
});
