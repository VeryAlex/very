
'use strict';

const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const userInfo = document.getElementById('user-info');
const adminPanel = document.getElementById('admin-panel');
const managerDashboard = document.getElementById('manager-dashboard');
const managerForm = document.getElementById('manager-form');
const managerList = document.getElementById('manager-list');

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Ошибка сервера');
  }

  return data;
}

function showLogin() {
  dashboard.hidden = true;
  loginScreen.hidden = false;
}

function showDashboard(user) {
  loginScreen.hidden = true;
  dashboard.hidden = false;

  userInfo.textContent =
    `${user.display_name} · ${user.email} · ${
      user.role === 'admin' ? 'Администратор' : 'Менеджер'
    }`;

  adminPanel.hidden = user.role !== 'admin';
  managerDashboard.hidden = user.role === 'admin';

  if (user.role === 'admin') {
    loadManagers();
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();

  const button = loginForm.querySelector('button[type="submit"]');
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  loginError.textContent = '';
  button.disabled = true;
  button.textContent = 'Входим...';

  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    loginForm.reset();
    showDashboard(result.user);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Войти';
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error('Logout error:', error);
  }

  showLogin();
});

async function loadManagers() {
  managerList.textContent = 'Загрузка сотрудников...';

  try {
    const result = await api('/api/admin/users');

    managerList.replaceChildren();

    if (!result.users.length) {
      managerList.textContent = 'Пока нет созданных пользователей.';
      return;
    }

    result.users.forEach(user => {
      const card = document.createElement('div');
      card.className = 'manager-card';

      const info = document.createElement('div');

      const name = document.createElement('strong');
      name.textContent = user.display_name;

      const email = document.createElement('small');
      email.textContent = user.email;

      const status = document.createElement('small');
      status.textContent = user.role === 'admin'
        ? 'Администратор'
        : user.is_active ? 'Активен' : 'Заблокирован';

      info.append(name, email, status);
      card.append(info);

      if (user.role === 'manager') {
        const button = document.createElement('button');
        button.className = 'secondary';
        button.type = 'button';
        button.textContent = user.is_active ? 'Заблокировать' : 'Активировать';

        button.addEventListener('click', async () => {
          button.disabled = true;

          try {
            const action = user.is_active ? 'deactivate' : 'active';

            await api(`/api/admin/users/${user.id}/${action}`, {
              method: 'POST'
            });

            await loadManagers();
          } catch (error) {
            alert(error.message);
            button.disabled = false;
          }
        });

        card.append(button);
      }

      managerList.append(card);
    });
  } catch (error) {
    managerList.textContent = error.message;
  }
}

managerForm.addEventListener('submit', async event => {
  event.preventDefault();

  const button = managerForm.querySelector('button[type="submit"]');
  const errorElement = document.getElementById('manager-error');
  const successElement = document.getElementById('manager-success');

  errorElement.textContent = '';
  successElement.textContent = '';

  const payload = {
    display_name: document.getElementById('manager-name').value.trim(),
    email: document.getElementById('manager-email').value.trim(),
    password: document.getElementById('manager-password').value
  };

  button.disabled = true;
  button.textContent = 'Создание...';

  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    managerForm.reset();
    successElement.textContent = 'Менеджер успешно создан.';

    await loadManagers();
  } catch (error) {
    errorElement.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Создать менеджера';
  }
});

async function initialize() {
  try {
    const result = await api('/api/auth/me');
    showDashboard(result.user);
  } catch {
    showLogin();
  }
}

initialize();
