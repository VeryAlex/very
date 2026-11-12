'use strict';

const $ = id => document.getElementById(id);

const state = {
  user: null,
  chats: [],
  activeChat: null,
  messages: [],
  managers: [],
  filter: 'all',
  events: null,
  sending: false,
  quickReplies: [],
  personalStatuses: [],
  personalStatusAssignments: [],
  personalStatusFilter: ''
};

const notifiedMessages = new Set();

// ===== VD INCOMING NOTIFICATION BANNERS =====

function showIncomingBanner(data) {
  if (data.direction !== 'in') return;

  const chat = state.chats.find(value =>
    String(value.id) === String(data.local_chat_id) ||
    String(value.avito_chat_id) === String(data.chat_id)
  );

  if (!chat) return;

  // Не отвлекаем, если этот диалог уже открыт.
  if (String(state.activeChat?.id) === String(chat.id)) return;

  let container = document.getElementById('vd-notifications');

  if (!container) {
    container = document.createElement('div');
    container.id = 'vd-notifications';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-label', 'Новые уведомления');
    document.body.appendChild(container);
  }

  while (container.children.length >= 3) {
    container.firstElementChild.remove();
  }

  const banner = document.createElement('button');
  banner.type = 'button';
  banner.className = 'vd-notification';

  const heading = document.createElement('strong');
  heading.className = 'vd-notification-title';
  heading.textContent = chat.peer_name || 'Новый клиент';

  const message = document.createElement('span');
  message.className = 'vd-notification-message';

  const preview = data.body ||
    (data.type === 'image' ? '📷 Фотография' :
     data.type === 'voice' ? '🎙 Голосовое сообщение' :
     'Новое сообщение');

  message.textContent = preview;

  const hint = document.createElement('span');
  hint.className = 'vd-notification-hint';
  hint.textContent = 'Нажмите, чтобы открыть переписку';

  banner.append(heading, message, hint);
  container.appendChild(banner);

  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    banner.classList.add('vd-notification-hide');
    setTimeout(() => banner.remove(), 220);
  };

  banner.addEventListener('click', async () => {
    dismiss();

    await openChat(chat);

    document.querySelector('.messenger')
      ?.classList.add('mobile-chat-open');
  });

  setTimeout(dismiss, 8000);
}

// ===== END VD INCOMING NOTIFICATION BANNERS =====

let replyTarget = null;

function updateUnreadSummary() {
  const badge = $('global-unread-count');
  if (badge) badge.remove();
  document.title = 'Very Delivery CRM';
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Ошибка ${response.status}`);
    error.status = response.status;
    throw error;
  }


  return data;
}

// ===== VD WEB PUSH CLIENT =====

let pushRegistration = null;

function decodePushKey(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const raw = atob(base64);

  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function initPushControls() {
  const button = $('push-toggle');
  const testButton = $('push-test');
  const status = $('push-status');

  if (!('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)) {
    status.textContent = 'Push не поддерживается';
    button.disabled = true;
    return;
  }

  try {
    pushRegistration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/'
    });

    const subscription =
      await pushRegistration.pushManager.getSubscription();

    if (subscription) {
      button.querySelector('.push-label').textContent = 'Выключить';
      testButton.hidden = false;
      status.textContent = 'Push включён';
    } else {
      button.querySelector('.push-label').textContent =
        Notification.permission === 'denied'
          ? 'Заблокировано'
          : 'Включить';

      testButton.hidden = true;

      status.textContent =
        Notification.permission === 'denied'
          ? 'Разрешение заблокировано'
          : 'Push выключен';
    }

    button.disabled = Notification.permission === 'denied' &&
      !subscription;

  } catch (error) {
    console.error('PUSH INIT ERROR:', error);
    status.textContent = 'Ошибка Push';
    button.disabled = true;
  }
}

$('push-toggle').addEventListener('click', async () => {
  const button = $('push-toggle');
  const status = $('push-status');
  const label = button.querySelector('.push-label');

  button.disabled = true;

  try {
    if (!pushRegistration) {
      pushRegistration = await navigator.serviceWorker.register('/sw.js');
    }

    let subscription =
      await pushRegistration.pushManager.getSubscription();

    if (subscription) {
      await api('/api/push/subscribe', {
        method: 'DELETE',
        body: JSON.stringify({
          endpoint: subscription.endpoint
        })
      });

      await subscription.unsubscribe();

      status.textContent = 'Push выключен';
      label.textContent = 'Включить';
      $('push-test').hidden = true;

    } else {
      let permission = Notification.permission;

      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }

      if (permission !== 'granted') {
        throw new Error(
          permission === 'denied'
            ? 'Разрешите уведомления в настройках браузера'
            : 'Разрешение на уведомления не получено'
        );
      }

      const keyData = await api('/api/push/public-key');

      subscription = await pushRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodePushKey(keyData.publicKey)
      });

      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: subscription.toJSON()
        })
      });

      status.textContent = 'Push включён';
      label.textContent = 'Выключить';
      $('push-test').hidden = false;
    }

  } catch (error) {
    console.error('PUSH TOGGLE ERROR:', error);
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    await initPushControls();
  }
});

$('push-test').addEventListener('click', async () => {
  const button = $('push-test');
  const status = $('push-status');

  button.disabled = true;

  try {
    const result = await api('/api/push/test', {
      method: 'POST'
    });

    status.textContent = `Тест отправлен: ${result.sent}`;
  } catch (error) {
    console.error('PUSH TEST ERROR:', error);
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// ===== END VD WEB PUSH CLIENT =====

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function showLogin() {
  state.events?.close();
  state.events = null;
  $('login-screen').hidden = false;
  $('dashboard').hidden = true;
}

async function showDashboard(user) {
  state.user = user;

  $('login-screen').hidden = true;
  $('dashboard').hidden = false;

  $('user-info').textContent =
    `${user.display_name || user.email} · ${user.role === 'admin' ? 'Администратор' : 'Менеджер'}`;

  $('brand-mobile-title').textContent =
    `VD — ${user.display_name || user.email}`;

  $('admin-panel').hidden = user.role !== 'admin';

  if (user.role === 'admin') {
    await loadManagers();
  }

  await loadChats();
  await loadPersonalStatuses();
  await loadQuickReplies();
  connectEvents();
  await initPushControls();
}

async function loadManagers() {
  try {
    const data = await api('/api/admin/users');
    state.managers = (data.users || []).filter(
      manager => manager.role === 'manager' && manager.is_active
    );
    renderManagers();
    if (state.activeChat) updateConversationHeader();
  } catch (error) {
    console.error('MANAGERS:', error);
  }
}

function renderManagers() {
  $('manager-list').innerHTML = state.managers.map(manager => `
    <div class="manager-row">
      <span>${escapeHTML(manager.display_name)} · ${escapeHTML(manager.email)}</span>
      <span class="success">Активен</span>
      <button class="small-button"
        data-toggle-manager="${manager.id}"
        data-active="true">
        Отключить
      </button>
    </div>
  `).join('');
}

$('manager-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-toggle-manager]');
  if (!button) return;

  const id = button.dataset.toggleManager;

  try {
    await api(`/api/admin/users/${id}/deactivate`, {
      method: 'POST'
    });

    await loadManagers();
    await loadChats();
  } catch (error) {
    $('manager-error').textContent = error.message;
  }
});

$('manager-form').addEventListener('submit', async event => {
  event.preventDefault();

  $('manager-error').textContent = '';
  $('manager-success').textContent = '';

  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        display_name: $('manager-name').value.trim(),
        email: $('manager-email').value.trim(),
        password: $('manager-password').value
      })
    });

    $('manager-form').reset();
    $('manager-success').textContent = 'Менеджер создан';

    await loadManagers();
  } catch (error) {
    $('manager-error').textContent = error.message;
  }
});

// ===== VD PERSONAL CHAT STATUSES =====

async function loadPersonalStatuses() {
  if (!state.user) return;

  try {
    const [statusesData, assignmentsData] = await Promise.all([
      api('/api/chat-statuses'),
      api('/api/chat-status-assignments')
    ]);

    state.personalStatuses = statusesData.statuses || [];
    state.personalStatusAssignments =
      assignmentsData.assignments || [];

    renderPersonalStatusFilter();
    renderChats();

    if (state.activeChat) {
      renderPersonalStatusControl();
    }

    console.log(
      'PERSONAL STATUSES:',
      state.personalStatuses.length,
      'ASSIGNMENTS:',
      state.personalStatusAssignments.length
    );
  } catch (error) {
    console.error('PERSONAL STATUSES:', error);
  }
}

function renderPersonalStatusFilter() {
  const container = $('personal-status-filters');
  const select = $('personal-status-filter');
  const manageButton = $('personal-status-manage');

  if (!container || !select || !state.user) return;

  const isAdmin = state.user.role === 'admin';

  container.hidden = false;
  manageButton.hidden = isAdmin;

  const selected = state.personalStatusFilter;

  select.replaceChildren();

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Все личные статусы';
  select.appendChild(defaultOption);

  for (const status of state.personalStatuses) {
    const option = document.createElement('option');
    option.value = String(status.id);
    option.textContent = isAdmin
      ? `${status.manager_name || 'Менеджер'}: ${status.name}`
      : status.name;
    select.appendChild(option);
  }

  if ([...select.options].some(option => option.value === selected)) {
    select.value = selected;
  } else {
    state.personalStatusFilter = '';
    select.value = '';
  }
}

function renderPersonalStatusControl() {
  const container = $('personal-status-control');
  const chat = state.activeChat;

  if (!container) return;

  container.replaceChildren();

  if (!chat || !state.user) {
    container.hidden = true;
    return;
  }

  const isAdmin = state.user.role === 'admin';

  const assignments = state.personalStatusAssignments.filter(
    assignment => String(assignment.chat_id) === String(chat.id)
  );

  if (isAdmin) {
    container.hidden = assignments.length === 0;

    for (const assignment of assignments) {
      const label = document.createElement('span');
      label.className = 'personal-status-label';
      label.textContent =
        `${assignment.manager_name || 'Менеджер'}: ${assignment.status_name}`;
      container.appendChild(label);
    }

    return;
  }

  container.hidden = false;

  const select = document.createElement('select');
  select.id = 'personal-status-select';
  select.setAttribute('aria-label', 'Личный статус переписки');

  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = 'Без личного статуса';
  select.appendChild(emptyOption);

  for (const status of state.personalStatuses) {
    const option = document.createElement('option');
    option.value = String(status.id);
    option.textContent = status.name;
    select.appendChild(option);
  }

  const current = assignments.find(
    assignment =>
      String(assignment.manager_id) === String(state.user.id)
  );

  select.value = current ? String(current.status_id) : '';

  // Настоящий select сохраняет существующий обработчик API.
  select.classList.add('personal-status-native-select');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const wrapper = document.createElement('div');
  wrapper.className = 'personal-status-dropdown';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'personal-status-trigger';
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'personal-status-menu';
  menu.hidden = true;

  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function updateTrigger() {
    const selected = select.options[select.selectedIndex];
    trigger.textContent = selected ? selected.textContent : 'Без личного статуса';
  }

  for (const option of Array.from(select.options)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'personal-status-menu-item';
    item.dataset.value = option.value;

    const label = document.createElement('span');
    label.textContent = option.textContent;

    const check = document.createElement('span');
    check.className = 'personal-status-menu-check';
    check.textContent = '✓';

    item.append(label, check);

    if (option.value === select.value) {
      item.classList.add('is-selected');
    }

    item.addEventListener('click', () => {
      if (select.disabled) return;

      const changed = select.value !== option.value;
      select.value = option.value;
      updateTrigger();
      closeMenu();

      if (changed) {
        trigger.disabled = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    if (option.value && !isAdmin) {
      const row = document.createElement('div');
      row.className = 'personal-status-edit-row';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'personal-status-icon-button';
      edit.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"
        width="20" height="20" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"
        aria-hidden="true">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
      </svg>`;
      edit.title = 'Переименовать статус';
      edit.setAttribute('aria-label', 'Переименовать статус');

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'personal-status-icon-button';
      remove.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"
        width="20" height="20" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"
        aria-hidden="true">
        <path d="M3 6h18"/>
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>
        <path d="M5 6l1 15h12l1-15"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
      </svg>`;
      remove.title = 'Удалить статус';
      remove.setAttribute('aria-label', 'Удалить статус');

      row.append(item, edit, remove);
      menu.appendChild(row);

      edit.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        // Сохраняем оба выпадающих меню открытыми.
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');

        const mobileMenu = document.getElementById('mobile-chat-menu');
        if (mobileMenu) {
          mobileMenu.classList.add('is-open');
          document.getElementById('mobile-chat-menu-toggle')
            ?.setAttribute('aria-expanded', 'true');
        }

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'personal-status-row-input';
        input.value = option.textContent;
        input.maxLength = 100;

        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = '✓';
        save.className = 'personal-status-icon-button';
        save.title = 'Сохранить';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '×';
        cancel.className = 'personal-status-icon-button';
        cancel.title = 'Отмена';

        const restore = () => {
          input.replaceWith(item);
          save.replaceWith(edit);
          cancel.replaceWith(remove);
        };

        item.replaceWith(input);
        edit.replaceWith(save);
        remove.replaceWith(cancel);

        cancel.addEventListener('click', restore);

        save.addEventListener('click', async () => {
          const name = input.value.trim();
          if (!name) return;

          save.disabled = true;

          try {
            await api(
              `/api/chat-statuses/${encodeURIComponent(option.value)}`,
              {
                method: 'PATCH',
                body: JSON.stringify({ name })
              }
            );

            // Обновляем данные без пересоздания открытого меню.
            const updated = state.personalStatuses.find(
              status => String(status.id) === String(option.value)
            );
            if (updated) updated.name = name;

            option.textContent = name;
            label.textContent = name;

            // Возвращаем обычную строку, сохраняя меню открытым.
            restore();

            if (select.value === option.value) {
              updateTrigger();
            }

            renderPersonalStatusFilter();
            renderChats();

          } catch (error) {
            alert(error.message);
            save.disabled = false;
          }
        });

        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save.click();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel.click();
          }
        });

        input.focus();
        input.select();
      });

      remove.addEventListener('click', async () => {
        const confirmed = confirm(
          `Удалить статус «${option.textContent}»?\\n\\n` +
          'Он будет снят со всех переписок.'
        );

        if (!confirmed) return;

        remove.disabled = true;

        try {
          await api(
            `/api/chat-statuses/${encodeURIComponent(option.value)}`,
            { method: 'DELETE' }
          );

          if (String(state.personalStatusFilter) === option.value) {
            state.personalStatusFilter = '';
          }

          await loadPersonalStatuses();
        } catch (error) {
          alert(error.message);
          remove.disabled = false;
        }
      });
    } else {
      menu.appendChild(item);
    }
  }

  // Создание личного статуса прямо в выпадающем списке.
  const createButton = document.createElement('button');
  createButton.type = 'button';
  createButton.className = 'personal-status-create-trigger';
  createButton.textContent = '+ Создать статус';

  const createForm = document.createElement('form');
  createForm.className = 'personal-status-dropdown-create';
  createForm.hidden = true;

  const createInput = document.createElement('input');
  createInput.type = 'text';
  createInput.maxLength = 100;
  createInput.placeholder = 'Название статуса';
  createInput.required = true;

  const createSubmit = document.createElement('button');
  createSubmit.type = 'submit';
  createSubmit.textContent = 'Сохранить';

  const createError = document.createElement('span');
  createError.className = 'personal-status-create-error';
  createError.setAttribute('role', 'alert');

  createForm.append(createInput, createSubmit, createError);
  menu.append(createButton, createForm);

  createButton.addEventListener('click', () => {
    createForm.hidden = false;
    createButton.hidden = true;
    createInput.focus();
  });

  createForm.addEventListener('submit', async event => {
    event.preventDefault();

    const name = createInput.value.trim();
    const chatId = String(state.activeChat?.id || '');

    if (!name || !chatId || state.user?.role !== 'manager') return;

    createSubmit.disabled = true;
    createError.textContent = '';

    try {
      const created = await api('/api/chat-statuses', {
        method: 'POST',
        body: JSON.stringify({ name })
      });

      const statusId = created.id || created.status?.id;

      if (!statusId) {
        throw new Error('Статус создан, но его ID не получен. Обновите список.');
      }

      await api(
        `/api/chat-status-assignments/${encodeURIComponent(chatId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ status_id: Number(statusId) })
        }
      );

      await loadPersonalStatuses();
      renderChats();

      if (String(state.activeChat?.id) === chatId) {
        renderPersonalStatusControl();
      }

    } catch (error) {
      console.error('PERSONAL STATUS DROPDOWN CREATE:', error);
      createError.textContent = error.message;
    } finally {
      createSubmit.disabled = false;
    }
  });

  trigger.addEventListener('click', () => {
    if (select.disabled) return;

    const opening = menu.hidden;
    document.querySelectorAll('.personal-status-menu').forEach(other => {
      other.hidden = true;
    });

    menu.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
  });

  wrapper.append(trigger, menu, select);
  container.appendChild(wrapper);
  updateTrigger();

  // Обработчик на документе назначается один раз.
  if (!window.personalStatusOutsideClickInstalled) {
    window.personalStatusOutsideClickInstalled = true;

    document.addEventListener('click', event => {
      document.querySelectorAll('.personal-status-dropdown').forEach(dropdown => {
        if (dropdown.contains(event.target)) return;

        const dropdownMenu = dropdown.querySelector('.personal-status-menu');
        const dropdownTrigger = dropdown.querySelector('.personal-status-trigger');

        if (dropdownMenu) dropdownMenu.hidden = true;
        if (dropdownTrigger) {
          dropdownTrigger.setAttribute('aria-expanded', 'false');
        }
      });
    });

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;

      document.querySelectorAll('.personal-status-dropdown').forEach(dropdown => {
        const dropdownMenu = dropdown.querySelector('.personal-status-menu');
        const dropdownTrigger = dropdown.querySelector('.personal-status-trigger');

        if (dropdownMenu) dropdownMenu.hidden = true;
        if (dropdownTrigger) {
          dropdownTrigger.setAttribute('aria-expanded', 'false');
          dropdownTrigger.focus();
        }
      });
    });
  }
}

$('personal-status-control').addEventListener('change', async event => {
  if (event.target.id !== 'personal-status-select') return;
  if (!state.activeChat || state.user?.role === 'admin') return;

  const select = event.target;
  const chatId = String(state.activeChat.id);
  const statusId = select.value;

  select.disabled = true;
  $('message-error').textContent = '';

  try {
    if (statusId) {
      await api(`/api/chat-status-assignments/${encodeURIComponent(chatId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          status_id: Number(statusId)
        })
      });
    } else {
      await api(`/api/chat-status-assignments/${encodeURIComponent(chatId)}`, {
        method: 'DELETE'
      });
    }

    await loadPersonalStatuses();
    renderChats();

    if (String(state.activeChat?.id) === chatId) {
      renderPersonalStatusControl();
    }
  } catch (error) {
    console.error('PERSONAL STATUS SAVE:', error);
    $('message-error').textContent = error.message;

    if (String(state.activeChat?.id) === chatId) {
      renderPersonalStatusControl();
    }
  } finally {
    if (select.isConnected) {
      select.disabled = false;
    }
  }
});

function renderPersonalStatusManageList() {
  const list = $('personal-status-manage-list');
  if (!list) return;

  list.replaceChildren();

  if (!state.personalStatuses.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Пока нет личных статусов';
    list.appendChild(empty);
    return;
  }

  for (const status of state.personalStatuses) {
    const row = document.createElement('div');
    row.className = 'personal-status-manage-row';

    const name = document.createElement('span');
    name.textContent = status.name;

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.renameStatus = String(status.id);
    rename.textContent = 'Изменить';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.deleteStatus = String(status.id);
    remove.textContent = 'Удалить';

    row.append(name, rename, remove);
    list.appendChild(row);
  }
}

$('personal-status-manage').addEventListener('click', () => {
  if (state.user?.role !== 'manager') return;

  $('personal-status-error').textContent = '';
  renderPersonalStatusManageList();

  $('personal-status-dialog').showModal();
});

$('personal-status-dialog-close').addEventListener('click', () => {
  $('personal-status-dialog').close();
});

$('personal-status-create-form').addEventListener('submit', async event => {
  event.preventDefault();

  if (state.user?.role !== 'manager') return;

  const input = $('personal-status-new-name');
  const errorElement = $('personal-status-error');
  const name = input.value.trim();

  if (!name) return;

  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  errorElement.textContent = '';

  try {
    await api('/api/chat-statuses', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    input.value = '';

    await loadPersonalStatuses();
    renderPersonalStatusManageList();

  } catch (error) {
    console.error('PERSONAL STATUS CREATE:', error);
    errorElement.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

$('personal-status-manage-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-rename-status]');
  if (!button || state.user?.role !== 'manager') return;

  const statusId = button.dataset.renameStatus;
  const status = state.personalStatuses.find(
    item => String(item.id) === statusId
  );

  if (!status) return;

  const row = button.closest('.personal-status-manage-row');
  if (!row) return;

  const nameElement = row.querySelector('span');
  if (!nameElement) return;

  // Закрываем предыдущее редактирование, если оно открыто.
  const previousCancel = $('personal-status-manage-list')
    .querySelector('[data-cancel-inline-rename]');
  if (previousCancel) previousCancel.click();

  const input = document.createElement('input');
  input.type = 'text';
  input.value = status.name;
  input.maxLength = 60;
  input.className = 'personal-status-inline-input';

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Сохранить';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  cancel.dataset.cancelInlineRename = '1';

  const remove = row.querySelector('[data-delete-status]');
  if (!remove) return;

  nameElement.replaceWith(input);
  button.hidden = true;
  remove.hidden = true;
  row.insertBefore(save, button);
  row.insertBefore(cancel, button);

  const restore = () => {
    input.replaceWith(nameElement);
    save.remove();
    cancel.remove();
    button.hidden = false;
    remove.hidden = false;
  };

  cancel.addEventListener('click', restore);

  save.addEventListener('click', async () => {
    const name = input.value.trim();
    const errorElement = $('personal-status-error');

    if (!name) {
      errorElement.textContent = 'Введите название статуса';
      input.focus();
      return;
    }

    if (name === status.name) {
      restore();
      return;
    }

    save.disabled = true;
    cancel.disabled = true;
    errorElement.textContent = '';

    try {
      await api(`/api/chat-statuses/${encodeURIComponent(statusId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });

      await loadPersonalStatuses();
      renderPersonalStatusManageList();

    } catch (error) {
      console.error('PERSONAL STATUS RENAME:', error);
      errorElement.textContent = error.message;
      save.disabled = false;
      cancel.disabled = false;
    }
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save.click();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      cancel.click();
    }
  });

  input.focus();
  input.select();
});

async function handlePersonalStatusDelete(event) {
  const button = event.target.closest('[data-delete-status]');
  if (!button || state.user?.role !== 'manager') return;

  const statusId = button.dataset.deleteStatus;
  const status = state.personalStatuses.find(
    item => String(item.id) === statusId
  );

  if (!status) return;

  const confirmed = confirm(
    `Удалить личный статус «${status.name}»?\\n\\n` +
    'Он будет снят со всех переписок, где вы его установили.'
  );

  if (!confirmed) return;

  const errorElement = $('personal-status-error');
  errorElement.textContent = '';
  button.disabled = true;

  try {
    await api(`/api/chat-statuses/${encodeURIComponent(statusId)}`, {
      method: 'DELETE'
    });

    if (String(state.personalStatusFilter) === statusId) {
      state.personalStatusFilter = '';
    }

    await loadPersonalStatuses();
    renderPersonalStatusManageList();

  } catch (error) {
    console.error('PERSONAL STATUS DELETE:', error);
    errorElement.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$('personal-status-manage-list').addEventListener(
  'click',
  handlePersonalStatusDelete
);

// ===== END VD PERSONAL CHAT STATUSES =====

// ЗАГРУЗКА ЧАТОВ

let chatsRequestId = 0;

async function loadChats() {
  const requestId = ++chatsRequestId;

  try {
    const data = await api('/api/chats');

    // Игнорируем устаревшие ответы
    if (requestId !== chatsRequestId) return;

    state.chats = data.chats || [];
    updateUnreadSummary();

    if (state.activeChat) {
      const updated = state.chats.find(
        chat => String(chat.id) === String(state.activeChat.id)
      );

      if (updated) {
        state.activeChat = updated;
        updateConversationHeader();
      } else {
        closeChat();
      }
    }

    renderChats();
  } catch (error) {
    if (requestId !== chatsRequestId) return;

    console.error('CHATS:', error);
    $('chat-count').textContent = 'Ошибка загрузки';

    if (error.status === 401) showLogin();
  }
}

// Обновляем данные после возвращения в приложение
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user) {
    loadChats();
  }
});

function filteredChats() {
  const query = $('chat-search').value.trim().toLowerCase();

  return state.chats.filter(chat => {
    const searchText = [
      chat.peer_name,
      chat.item_title,
      chat.last_message,
      chat.manager_name
    ].join(' ').toLowerCase();

    if (query && !searchText.includes(query)) return false;

    if (state.filter === 'free' && chat.manager_id != null) {
      return false;
    }

    if (state.filter === 'mine' &&
        String(chat.manager_id) !== String(state.user.id)) {
      return false;
    }

    if (state.personalStatusFilter) {
      const hasStatus = state.personalStatusAssignments.some(
        assignment =>
          String(assignment.chat_id) === String(chat.id) &&
          String(assignment.status_id) ===
            String(state.personalStatusFilter)
      );

      if (!hasStatus) return false;
    }

    return true;
  });
}

function renderChats() {
  const chats = filteredChats();

  $('chat-count').textContent =
    `${chats.length} из ${state.chats.length}`;

  if (!chats.length) {
    $('chat-list').innerHTML =
      '<div class="empty">Чаты не найдены</div>';
    return;
  }

  $('chat-list').innerHTML = chats.map(chat => {
    const active = state.activeChat &&
      String(state.activeChat.id) === String(chat.id);

    const initials = (chat.peer_name || 'К')
      .trim().slice(0, 1).toUpperCase();

    const date = chat.last_message_at
      ? new Date(chat.last_message_at).toLocaleDateString('ru-RU', {
          day: '2-digit',
          month: '2-digit'
        })
      : '';
    const unreadCount = Number(chat.unread_count || 0);

    const personalAssignments = state.personalStatusAssignments.filter(
      assignment => String(assignment.chat_id) === String(chat.id)
    );

    const personalStatusLabels = personalAssignments.map(assignment => {
      const label = state.user?.role === 'admin'
        ? `${assignment.manager_name || 'Менеджер'}: ${assignment.status_name}`
        : assignment.status_name;

      return `<span class="personal-status-label">${escapeHTML(label || '')}</span>`;
    }).join('');

    return `
      <button class="chat-item ${active ? 'active' : ''}"
        data-chat-id="${chat.id}">

        <div class="chat-item-avatar">
          <span>${escapeHTML(initials)}</span>
          ${typeof chat.item_image_url === 'string' &&
            /^https?:\/\//i.test(chat.item_image_url)
              ? `<img src="${escapeHTML(chat.item_image_url)}"
                   alt="" loading="lazy" onerror="this.remove()">`
              : ''}
        </div>

        <div class="chat-item-body">
          <div class="chat-item-top">
            <strong class="${unreadCount > 0 ? 'unread-name' : ''}">${escapeHTML(chat.peer_name || 'Клиент')}</strong>
            <div class="chat-item-meta">
              <time>${date}</time>
              ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ''}
            </div>
          </div>

          <div class="chat-item-product">
            ${escapeHTML(chat.item_title || 'Без объявления')}
          </div>

          <div class="chat-item-preview ${unreadCount > 0 ? "unread-preview" : ""}">
            ${escapeHTML(
              chat.last_message_type === 'image'
                ? '📷 Фотография'
                : chat.last_message_type === 'voice'
                  ? '🎙 Голосовое сообщение'
                  : chat.last_message_type === 'video'
                    ? '🎬 Видео'
                    : chat.last_message || 'Нет сообщений'
            )}
          </div>

          <div class="chat-item-bottom">
            <span class="status ${chat.manager_id == null ? 'free' : 'assigned'}">
              ${escapeHTML(chat.manager_name || (chat.manager_id == null ? 'Свободный чат' : 'Закреплён'))}
            </span>
            ${personalStatusLabels}
          </div>
        </div>
      </button>
    `;
  }).join('');
}

$('chat-list').addEventListener('click', event => {
  const item = event.target.closest('[data-chat-id]');
  if (!item) return;

  const chat = state.chats.find(
    value => String(value.id) === item.dataset.chatId
  );

  if (chat) openChat(chat);
});


// Управление панелью заметок
function setNotesPanelOpen(open) {
  const panel = $('notes-panel');
  const button = $('notes-toggle');

  if (!panel || !button) return;

  panel.classList.toggle('notes-panel-open', open);
  button.setAttribute('aria-expanded', String(open));
}

$('notes-close').addEventListener('click', () => {
  setNotesPanelOpen(false);
});

$('notes-toggle').addEventListener('click', () => {
  const panel = $('notes-panel');
  const open = !panel.classList.contains('notes-panel-open');
  setNotesPanelOpen(open);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    setNotesPanelOpen(false);
  }
});

// ===== NOTES MODULE VD =====

async function loadNotes(chatId) {
  const list = $('notes-list');
  if (!list) return;

  list.innerHTML = '<div class="notes-empty">Загрузка заметок...</div>';

  try {
    const data = await api(`/api/chats/${chatId}/notes`);

    if (String(state.activeChat?.id) !== String(chatId)) return;

    renderNotes(data.notes || []);
  } catch (error) {
    if (String(state.activeChat?.id) !== String(chatId)) return;

    list.innerHTML = '<div class="notes-empty">Не удалось загрузить заметки</div>';
    $('notes-error').textContent = error.message;
  }
}

function renderNotes(notes) {
  const list = $('notes-list');

  $('notes-count').textContent = notes.length;
  $('notes-toggle-count').textContent = notes.length;

  if (!notes.length) {
    list.innerHTML =
      '<div class="notes-empty">Пока нет заметок. Добавьте первую.</div>';
    return;
  }

  list.innerHTML = notes.map(note => {
    const date = new Date(note.created_at).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const own = String(note.user_id) === String(state.user.id);

    return `
      <article class="note-card" data-note-id="${note.id}">
        <div class="note-top">
          <strong>${escapeHTML(note.author_name || 'Сотрудник')}</strong>
          <time>${date}</time>
        </div>
        <div class="note-text">${escapeHTML(note.note)}</div>
        ${own ? `
          <div class="note-actions">
            <button type="button" data-note-edit="${note.id}">Изменить</button>
            <button type="button" data-note-delete="${note.id}">Удалить</button>
          </div>
        ` : ''}
      </article>
    `;
  }).join('');
}

// Добавление
$('notes-form').addEventListener('submit', async event => {
  event.preventDefault();

  const chatId = state.activeChat?.id;
  const input = $('notes-input');
  const value = input.value.trim();

  if (!chatId || !value) return;

  const button = $('notes-submit');
  button.disabled = true;
  $('notes-error').textContent = '';

  try {
    await api(`/api/chats/${chatId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ note: value })
    });

    input.value = '';
    await loadNotes(chatId);
  } catch (error) {
    $('notes-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// Редактирование и удаление
$('notes-list').addEventListener('click', async event => {
  const editButton = event.target.closest('[data-note-edit]');
  const deleteButton = event.target.closest('[data-note-delete]');

  const chatId = state.activeChat?.id;
  if (!chatId) return;

  if (editButton) {
    const id = editButton.dataset.noteEdit;
    const card = editButton.closest('.note-card');
    const current = card?.querySelector('.note-text')?.textContent || '';

    const updated = window.prompt('Изменить заметку:', current);

    if (updated === null || !updated.trim()) return;

    try {
      await api(`/api/chats/${chatId}/notes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: updated.trim() })
      });

      await loadNotes(chatId);
    } catch (error) {
      $('notes-error').textContent = error.message;
    }
  }

  if (deleteButton) {
    const id = deleteButton.dataset.noteDelete;

    if (!window.confirm('Удалить эту заметку?')) return;

    try {
      await api(`/api/chats/${chatId}/notes/${id}`, {
        method: 'DELETE'
      });

      await loadNotes(chatId);
    } catch (error) {
      $('notes-error').textContent = error.message;
    }
  }
});

// ===== END NOTES MODULE VD =====


// ОТКРЫТИЕ ПЕРЕПИСКИ

async function openChat(chat) {
  setNotesPanelOpen(false);
  state.activeChat = chat;
  state.messages = [];

  $('chat-placeholder').hidden = true;
  $('conversation-view').hidden = false;
  $('message-error').textContent = '';

  updateConversationHeader();
  renderChats();

  $('message-list').innerHTML =
    '<div class="empty">Загрузка сообщений...</div>';

  await Promise.all([
    refreshMessages(chat.id),
    loadNotes(chat.id)
  ]);
}

let messagesRequestId = 0;

async function refreshMessages(chatId) {
  const requestId = ++messagesRequestId;

  try {
    const data = await api(`/api/chats/${chatId}/messages`);

    if (
      requestId !== messagesRequestId ||
      String(state.activeChat?.id) !== String(chatId)
    ) return;

    state.messages = data.messages || [];
    state.voiceUrls = data.voice_urls || {};
    renderMessages();
  } catch (error) {
    console.error('MESSAGES:', error);

    if (
      requestId === messagesRequestId &&
      String(state.activeChat?.id) === String(chatId)
    ) {
      $('message-list').innerHTML =
        `<div class="empty">${escapeHTML(error.message)}</div>`;
    }
  }
}

// ЗАГОЛОВОК И НАЗНАЧЕНИЕ

function updateConversationHeader() {
  const chat = state.activeChat;
  if (!chat) return;

  const name = chat.peer_name || 'Клиент';
  const initials = Array.from(name.trim())[0]?.toUpperCase() || 'К';

  $('active-name').textContent = name;
  $('conversation-avatar').textContent = initials;

  const item = $('active-item');
  item.textContent = chat.item_title || 'Без объявления';

  const price = $('active-price');
  price.textContent = chat.item_price || '';
  price.hidden = !chat.item_price;

  if (chat.item_url) {
    item.href = chat.item_url;
    item.hidden = false;
    item.title = 'Открыть объявление на Avito';
  } else {
    item.removeAttribute('href');
    item.hidden = true;
  }

  renderPersonalStatusControl();

  const control = $('assignment-control');

  if (state.user.role === 'admin') {
    control.innerHTML = `
      <select id="manager-select" aria-label="Назначить менеджера">
        <option value="">Свободный чат</option>
        ${state.managers.map(manager => `
          <option value="${manager.id}"
            ${String(chat.manager_id) === String(manager.id) ? 'selected' : ''}>
            ${escapeHTML(manager.display_name)}
          </option>
        `).join('')}
      </select>
    `;
  } else {
    const isFree = chat.manager_id == null;
    const isMine = String(chat.manager_id) === String(state.user.id);

    control.innerHTML = isFree
      ? '<span class="status free">Свободный чат</span>'
      : isMine
        ? '<span class="status assigned">Ваш чат</span>'
        : '<span class="status assigned">Чат занят</span>';

    const composer = $('message-form');

    if (composer) {
      let claimButton = $('claim-chat-button');

      if (!claimButton) {
        claimButton = document.createElement('button');
        claimButton.type = 'button';
        claimButton.id = 'claim-chat-button';
        claimButton.className = 'claim-chat-button';
        claimButton.textContent = 'Принять чат';
        composer.appendChild(claimButton);
      }

      // Сбрасываем состояние кнопки при каждом открытии чата
      claimButton.disabled = false;
      claimButton.textContent = 'Принять чат';

      composer.hidden = !isFree && !isMine;
      composer.classList.toggle('claim-mode', isFree);
      claimButton.hidden = !isFree;
    }
  }
}

$('message-form').addEventListener('click', async event => {
  const button = event.target.closest('#claim-chat-button');
  if (!button || !state.activeChat) return;

  event.preventDefault();

  const chatId = state.activeChat.id;

  button.disabled = true;
  button.textContent = 'Принимаем...';
  $('message-error').textContent = '';

  try {
    await api(`/api/chats/${chatId}/claim`, {
      method: 'POST'
    });

    await loadChats();

    if (state.activeChat) {
      updateConversationHeader();
      $('message-input').focus();
    }

  } catch (error) {
    $('message-error').textContent = error.message;

    try {
      await loadChats();
    } catch (refreshError) {
      console.error('CLAIM REFRESH ERROR:', refreshError);
    }
  } finally {
    const currentButton = $('claim-chat-button');

    if (currentButton) {
      currentButton.disabled = false;
      currentButton.textContent = 'Принять чат';
    }
  }
});

$('assignment-control').addEventListener('change', async event => {
  if (event.target.id !== 'manager-select' || !state.activeChat) return;

  const chatId = state.activeChat.id;
  const value = event.target.value;

  event.target.disabled = true;
  $('message-error').textContent = '';

  try {
    await api(`/api/chats/${chatId}/assign`, {
      method: 'POST',
      body: JSON.stringify({
        manager_id: value ? Number(value) : null
      })
    });

    await loadChats();

    if (state.activeChat) {
      updateConversationHeader();
    }
  } catch (error) {
    $('message-error').textContent = error.message;
    updateConversationHeader();
  }
});

// ОТОБРАЖЕНИЕ СООБЩЕНИЙ



function setReplyTarget(message) {
  replyTarget = {
    body: String(message.body || '').trim(),
    chatId: String(state.activeChat?.id || '')
  };

  const panel = $('reply-preview');
  $('reply-preview-text').textContent =
    '«' + replyTarget.body + '»';

  panel.hidden = false;
}

function clearReplyTarget() {
  replyTarget = null;
  $('reply-preview').hidden = true;
  $('reply-preview-text').textContent = '';
}

$('reply-preview-cancel').addEventListener('click', clearReplyTarget);


function mediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function renderMessageContent(message) {
  const raw = message.raw || {};
  const content = raw.content || {};
  const type = message.message_type;

  if (type === 'image') {
    const sizes = content.image?.sizes || {};
    const url = mediaUrl(
      sizes['1280x960'] || sizes['640x480'] ||
      sizes['140x105'] || ''
    );

    if (url) {
      return `<img class="crm-message-image"
        src="${escapeHTML(url)}"
        alt="Фотография из переписки"
        loading="lazy"
        title="Нажмите, чтобы увеличить">`;
    }
  }

  if (type === 'voice') {
    const voiceId = content.voice?.voice_id;
    const url = mediaUrl(state.voiceUrls?.[voiceId]);

    if (url) {
      return `<div class="crm-voice">
        <span>🎙 Голосовое сообщение</span>
        <audio controls preload="none" src="${escapeHTML(url)}"></audio>
      </div>`;
    }

    return '<div class="crm-media-placeholder">🎙 Голосовое сообщение</div>';
  }

  if (type === 'link') {
    const url = mediaUrl(content.link?.url || message.body);

    if (url) {
      return `<a class="crm-message-link"
        href="${escapeHTML(url)}"
        target="_blank" rel="noopener noreferrer">${escapeHTML(content.link?.text || url)}</a>`;
    }
  }

  return escapeHTML(
    message.body || `[${type || 'Сообщение'}]`
  );
}

function renderMessages() {
  const list = $('message-list');

  if (!state.messages.length) {
    list.innerHTML =
      '<div class="empty">Начните переписку — сообщений пока нет</div>';
    return;
  }

  list.innerHTML = state.messages.map(message => {
    const outgoing = message.direction === 'out';
    const localId = escapeHTML(message.id);
    const bodyText = (message.body ||
      `[${message.message_type || 'Сообщение'}]`).trim();

    const deleted = message.message_type === 'deleted';
    const body = escapeHTML(
      deleted ? 'Сообщение удалено' : bodyText
    );

    const created = new Date(message.created_at).getTime();
    const age = Date.now() - created;

    const canDelete =
      outgoing &&
      !deleted &&
      Number.isFinite(created) &&
      age >= 0 &&
      age <= 60 * 60 * 1000;

    return `
      <div class="message-row ${outgoing ? 'outgoing' : 'incoming'}"
           data-message-id="${localId}">

        <div class="bubble">
          <div class="message-text">${renderMessageContent(message)}</div>

          <div class="message-menu">
            <button
              type="button"
              class="message-menu-toggle"
              data-message-menu-toggle
              aria-label="Действия с сообщением"
              title="Действия">⋯</button>

            <div class="message-menu-popup" hidden>
              ${!deleted ? `
                <button type="button"
                  data-message-action="reply"
                  data-message-id="${localId}">
                  Ответить
                </button>
              ` : ''}

              ${canDelete ? `
                <button type="button"
                  class="message-delete-action"
                  data-message-action="delete"
                  data-message-id="${localId}">
                  Удалить
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  list.scrollTop = list.scrollHeight;
}


document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const viewer = document.getElementById('crm-photo-viewer');
    if (viewer) viewer.classList.remove('open');
    document.body.classList.remove('crm-photo-open');
  }
});

// ===== МЕНЮ СООБЩЕНИЙ: ОТВЕТ И УДАЛЕНИЕ =====

$('message-list').addEventListener('click', async event => {

  const photo = event.target.closest('.crm-message-image');

  if (photo) {
    event.preventDefault();

    let viewer = document.getElementById('crm-photo-viewer');

    if (!viewer) {
      viewer = document.createElement('div');
      viewer.id = 'crm-photo-viewer';
      viewer.className = 'crm-photo-viewer';
      viewer.innerHTML = `
        <button type="button" class="crm-photo-close"
          aria-label="Закрыть">×</button>
        <img class="crm-photo-full" alt="Фотография">
      `;
      document.body.appendChild(viewer);

      viewer.addEventListener('click', event => {
        if (
          event.target === viewer ||
          event.target.closest('.crm-photo-close')
        ) {
          viewer.classList.remove('open');
          document.body.classList.remove('crm-photo-open');
        }
      });
    }

    viewer.querySelector('.crm-photo-full').src = photo.src;
    viewer.classList.add('open');
    document.body.classList.add('crm-photo-open');
    return;
  }

  const toggle = event.target.closest('[data-message-menu-toggle]');

  if (toggle) {
    const current = toggle.nextElementSibling;
    const shouldOpen = current.hidden;

    document.querySelectorAll('.message-menu-popup').forEach(menu => {
      menu.hidden = true;
    });

    current.hidden = !shouldOpen;
    return;
  }

  const action = event.target.closest('[data-message-action]');

  if (!action) return;

  const messageId = action.dataset.messageId;
  const message = state.messages.find(
    item => String(item.id) === String(messageId)
  );

  if (!message) return;

  document.querySelectorAll('.message-menu-popup').forEach(menu => {
    menu.hidden = true;
  });

  if (action.dataset.messageAction === 'reply') {
    const original = String(message.body || '').trim();
    if (!original) return;

    setReplyTarget(message);
    $('message-input').focus();

    return;
  }

  if (action.dataset.messageAction === 'delete') {
    if (!message.direction || message.direction !== 'out') return;

    if (!confirm(
      'Удалить это сообщение на Avito?\n\n' +
      'Действие необратимо. У собеседника останется отметка об удалении.'
    )) return;

    const chatId = state.activeChat?.id;
    if (!chatId) return;

    action.disabled = true;

    try {
      await api(
        `/api/chats/${chatId}/messages/${messageId}/delete`,
        { method: 'POST' }
      );

      await refreshMessages(chatId);
      await loadChats();

    } catch (error) {
      $('message-error').textContent =
        'Не удалось удалить сообщение: ' + error.message;
      action.disabled = false;
    }
  }
});

// Закрытие меню при нажатии вне сообщения
document.addEventListener('click', event => {
  if (event.target.closest('.message-menu')) return;

  document.querySelectorAll('.message-menu-popup').forEach(menu => {
    menu.hidden = true;
  });
});


// ===== ОБЩИЕ БЫСТРЫЕ ОТВЕТЫ =====

async function loadQuickReplies() {
  try {
    const data = await api('/api/quick-replies');
    state.quickReplies = data.replies || data.quick_replies || [];
    renderQuickReplies();
  } catch (error) {
    console.error('QUICK REPLIES:', error);
  }
}

function renderQuickReplies() {
  const list = $('quick-replies-list');
  if (!list) return;

  const query = ($('quick-reply-search').value || '')
    .trim().toLowerCase();

  const items = state.quickReplies.filter(item =>
    item.title.toLowerCase().includes(query) ||
    item.body.toLowerCase().includes(query)
  );

  if (!items.length) {
    list.innerHTML = '<div class="quick-replies-empty">Шаблонов не найдено</div>';
    return;
  }

  list.innerHTML = items.map(item => `
    <div class="quick-reply-item">
      <button type="button" class="quick-reply-use"
        data-quick-use="${escapeHTML(item.id)}">
        <strong>${escapeHTML(item.title)}</strong>
        <span>${escapeHTML(item.body)}</span>
      </button>
      <div class="quick-reply-actions">
        <button type="button" data-quick-edit="${escapeHTML(item.id)}"
          title="Редактировать">✎</button>
        <button type="button" data-quick-delete="${escapeHTML(item.id)}"
          title="Удалить">×</button>
      </div>
    </div>
  `).join('');
}

function openQuickReplyEditor(item = null) {
  $('quick-reply-id').value = item ? item.id : '';
  $('quick-reply-title').value = item ? item.title : '';
  $('quick-reply-body').value = item ? item.body : '';
  $('quick-reply-error').textContent = '';
  $('quick-reply-dialog-title').textContent =
    item ? 'Редактировать быстрый ответ' : 'Новый быстрый ответ';

  $('quick-reply-dialog').showModal();
}

$('composer-plus').addEventListener('click', () => {
  $('quick-replies-panel').hidden = true;
  $('composer-menu').hidden = !$('composer-menu').hidden;
});

$('open-quick-replies').addEventListener('click', async () => {
  $('composer-menu').hidden = true;
  await loadQuickReplies();
  $('quick-replies-panel').hidden = !$('quick-replies-panel').hidden;
  $('quick-reply-search').focus();
});

$('quick-reply-search').addEventListener('input', renderQuickReplies);

$('quick-reply-create').addEventListener('click', () => {
  openQuickReplyEditor();
});

$('quick-replies-list').addEventListener('click', async event => {
  const use = event.target.closest('[data-quick-use]');
  const edit = event.target.closest('[data-quick-edit]');
  const remove = event.target.closest('[data-quick-delete]');

  if (use) {
    const item = state.quickReplies.find(
      x => String(x.id) === use.dataset.quickUse
    );
    if (!item) return;

    const input = $('message-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);

    input.value = before + item.body + after;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.selectionStart = input.selectionEnd =
      start + item.body.length;

    $('quick-replies-panel').hidden = true;
    return;
  }

  if (edit) {
    const item = state.quickReplies.find(
      x => String(x.id) === edit.dataset.quickEdit
    );
    if (item) openQuickReplyEditor(item);
    return;
  }

  if (remove) {
    const id = remove.dataset.quickDelete;
    const item = state.quickReplies.find(x => String(x.id) === id);
    if (!item || !confirm(`Удалить шаблон «${item.title}»?`)) return;

    remove.disabled = true;

    try {
      await api(`/api/quick-replies/${id}`, { method: 'DELETE' });
      await loadQuickReplies();
    } catch (error) {
      alert(error.message);
      remove.disabled = false;
    }
  }
});

$('quick-reply-editor-form').addEventListener('submit', async event => {
  event.preventDefault();

  const id = $('quick-reply-id').value;
  const title = $('quick-reply-title').value.trim();
  const body = $('quick-reply-body').value.trim();

  const submit = event.submitter;
  if (submit) submit.disabled = true;

  try {
    await api(
      id ? `/api/quick-replies/${id}` : '/api/quick-replies',
      {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify({ title, body })
      }
    );

    $('quick-reply-dialog').close();
    await loadQuickReplies();
  } catch (error) {
    $('quick-reply-error').textContent = error.message;
  } finally {
    if (submit) submit.disabled = false;
  }
});

$('quick-reply-cancel').addEventListener('click', () => {
  $('quick-reply-dialog').close();
});

// Фото и видео: выбор файлов.
// Передача файлов в Avito будет подключена отдельным этапом.
$('choose-media').addEventListener('click', () => {
  $('composer-menu').hidden = true;
  $('media-input').click();
});

async function sendChatPhoto(file) {
  if (!file) return;

  if (!state.activeChat || state.sending) {
    $('message-error').textContent =
      'Дождитесь завершения предыдущей отправки';
    return;
  }

  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/bmp',
    'image/heic'
  ];

  if (!allowedTypes.includes(file.type)) {
    $('message-error').textContent =
      'Поддерживаются JPEG, PNG, GIF, BMP и HEIC';
    return;
  }

  if (!file.size || file.size > 20 * 1024 * 1024) {
    $('message-error').textContent =
      'Размер фотографии должен быть не более 20 МБ';
    return;
  }

  const chatId = state.activeChat.id;

  state.sending = true;
  $('send-button').disabled = true;
  $('message-input').disabled = true;
  $('choose-media').disabled = true;
  $('message-error').textContent = 'Отправка фотографии...';

  try {
    const response = await fetch(`/api/chats/${chatId}/images`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Image-Type': file.type
      },
      body: file
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || `Ошибка отправки: HTTP ${response.status}`
      );
    }

    $('message-error').textContent = '';

    if (String(state.activeChat?.id) === String(chatId)) {
      await refreshMessages(chatId);
    }

    await loadChats();

  } catch (error) {
    $('message-error').textContent = error.message;
  } finally {
    state.sending = false;
    $('send-button').disabled = false;
    $('message-input').disabled = false;
    $('choose-media').disabled = false;
  }
}

$('media-input').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  await sendChatPhoto(file);
});


// VD PHOTO DRAG AND DROP
// Работает только с открытым диалогом на компьютере.
const photoDropZone = $('conversation-view');
const photoDropOverlay = document.createElement('div');
photoDropOverlay.className = 'photo-drop-overlay';
photoDropOverlay.textContent = 'Отпустите, чтобы отправить фотографию';
photoDropOverlay.setAttribute('aria-hidden', 'true');
photoDropZone.appendChild(photoDropOverlay);

let photoDragDepth = 0;

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function clearPhotoDrag() {
  photoDragDepth = 0;
  photoDropZone.classList.remove('photo-drag-active');
}

photoDropZone.addEventListener('dragenter', event => {
  if (!hasDraggedFiles(event) || !state.activeChat) return;
  event.preventDefault();
  photoDragDepth++;
  photoDropZone.classList.add('photo-drag-active');
});

photoDropZone.addEventListener('dragover', event => {
  if (!hasDraggedFiles(event) || !state.activeChat) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

photoDropZone.addEventListener('dragleave', event => {
  if (!hasDraggedFiles(event)) return;
  photoDragDepth = Math.max(0, photoDragDepth - 1);
  if (photoDragDepth === 0) clearPhotoDrag();
});

photoDropZone.addEventListener('drop', async event => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  clearPhotoDrag();

  if (!state.activeChat) return;

  const files = Array.from(event.dataTransfer.files || []);

  if (files.length !== 1) {
    $('message-error').textContent =
      'Перетащите только одну фотографию';
    return;
  }

  await sendChatPhoto(files[0]);
});

window.addEventListener('dragend', clearPhotoDrag);
window.addEventListener('drop', clearPhotoDrag);
// END VD PHOTO DRAG AND DROP

document.addEventListener('click', event => {
  if (event.target.closest('.composer-tools') ||
      event.target.closest('.quick-replies-panel')) return;

  $('composer-menu').hidden = true;
  $('quick-replies-panel').hidden = true;
});

// ===== КОНЕЦ БЫСТРЫХ ОТВЕТОВ =====


// ОТПРАВКА СООБЩЕНИЯ

$('message-form').addEventListener('submit', async event => {
  event.preventDefault();

  if (!state.activeChat || state.sending) return;

  const input = $('message-input');
  const text = input.value.trim();

  if (!text) return;

  if (replyTarget &&
      replyTarget.chatId !== String(state.activeChat.id)) {
    clearReplyTarget();
  }

  const outgoingText = replyTarget
    ? `«${replyTarget.body}»\n\n${text}`
    : text;

  const chatId = state.activeChat.id;

  state.sending = true;
  $('send-button').disabled = true;
  input.disabled = true;
  $('message-error').textContent = '';

  try {
    await api(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: outgoingText })
    });

    input.value = '';
    clearReplyTarget();
    input.style.height = '44px';
    input.style.overflowY = 'hidden';
    input.scrollTop = 0;
    input.style.height = '44px';

    await refreshMessages(chatId);
    await loadChats();

  } catch (error) {
    $('message-error').textContent = error.message;
  } finally {
    state.sending = false;
    $('send-button').disabled = false;
    input.disabled = false;
    input.focus();
  }
});

// ENTER ДЛЯ ОТПРАВКИ

$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('message-form').requestSubmit();
  }
});

// АВТОВЫСОТА ПОЛЯ

$('message-input').addEventListener('input', event => {
  const input = event.target;

  const isMobile = window.matchMedia('(max-width: 760px)').matches;
  const maxHeight = isMobile ? 104 : 120;

  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, maxHeight) + 'px';
  input.style.overflowY =
    input.scrollHeight > maxHeight ? 'auto' : 'hidden';
});

// ЗАКРЫТИЕ ЧАТА

function closeChat() {
  state.activeChat = null;
  state.messages = [];

  $('conversation-view').hidden = true;
  $('chat-placeholder').hidden = false;

  renderChats();
}

// ЗВУК НОВОГО СООБЩЕНИЯ
let audioContext = null;

function playNotification() {
  try {
    if (!audioContext) {
      audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      audioContext.currentTime + 0.18
    );

    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.18);
  } catch (error) {
    console.warn('Звук уведомления недоступен:', error);
  }
}

// SSE — МОМЕНТАЛЬНЫЕ ОБНОВЛЕНИЯ

function connectEvents() {
  state.events?.close();

  const events = new EventSource('/api/events');
  state.events = events;

  events.addEventListener('message_deleted', async event => {
    try {
      const data = JSON.parse(event.data);

      if (
        state.activeChat &&
        String(state.activeChat.id) === String(data.local_chat_id)
      ) {
        await refreshMessages(state.activeChat.id);
      }

      await loadChats();
    } catch (error) {
      console.error('MESSAGE DELETE SYNC:', error);
    }
  });


  events.onopen = () => {
    $('connection-status').textContent = '● Онлайн';
    $('connection-status').classList.add('online');
    loadChats();
  };

  events.onerror = () => {
    $('connection-status').textContent = 'Переподключение...';
    $('connection-status').classList.remove('online');
  };

  events.addEventListener('message', async event => {
    let data;

    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    await loadChats();

    showIncomingBanner(data);

    const chat = state.activeChat;

    if (chat &&
        (String(data.local_chat_id) === String(chat.id) ||
         String(data.chat_id) === String(chat.avito_chat_id))) {
      await refreshMessages(chat.id);
    }

    if (data.direction === 'in') {
      const notificationId = String(
        data.message_id ||
        data.id ||
        `${data.chat_id || data.local_chat_id}:${data.created_at || ''}`
      );

      if (!notifiedMessages.has(notificationId)) {
        notifiedMessages.add(notificationId);

        if (notifiedMessages.size > 1000) {
          const first = notifiedMessages.values().next().value;
          notifiedMessages.delete(first);
        }

        playNotification();
      }
    }
  });

  // СИНХРОНИЗАЦИЯ ПРОЧИТАНИЯ МЕЖДУ СОТРУДНИКАМИ
  events.addEventListener('read', async event => {
    try {
      const data = JSON.parse(event.data);
      console.log('READ SYNC:', data.chat_id);
      await loadChats();
    } catch (error) {
      console.error('READ SYNC ERROR:', error);
    }
  });

  events.addEventListener('note', async event => {
    try {
      const data = JSON.parse(event.data);
      if (String(state.activeChat?.id) === String(data.chat_id)) {
        await loadNotes(data.chat_id);
      }
    } catch (error) {
      console.error('NOTES SYNC ERROR:', error);
    }
  });

  events.addEventListener('chat-status', async () => {
    try {
      await loadPersonalStatuses();
    } catch (error) {
      console.error('PERSONAL STATUS SSE:', error);
    }
  });

  events.addEventListener('quick_replies', async () => {
    await loadQuickReplies();
  });

  events.addEventListener('assignment', async event => {
    try {
      const data = JSON.parse(event.data || '{}');

      if (
        state.user.role === 'manager' &&
        data.manager_id != null &&
        String(data.manager_id) !== String(state.user.id)
      ) {
        const chatId = String(data.chat_id);

        state.chats = state.chats.filter(
          chat => String(chat.id) !== chatId
        );

        if (
          state.activeChat &&
          String(state.activeChat.id) === chatId
        ) {
          closeChat();
        }

        updateUnreadSummary();
        renderChats();
      }

      await loadChats();
    } catch (error) {
      console.error('ASSIGNMENT SYNC ERROR:', error);
      await loadChats();
    }
  });

}

// ПОИСК И ФИЛЬТРЫ

$('personal-status-filter').addEventListener('change', event => {
  state.personalStatusFilter = event.target.value;
  renderChats();
});

$('chat-search').addEventListener('input', renderChats);

document.querySelectorAll('[data-filter]').forEach(button => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;

    document.querySelectorAll('[data-filter]').forEach(item => {
      item.classList.toggle('active', item === button);
    });

    renderChats();
  });
});

$('refresh-chats').addEventListener('click', loadChats);

$('back-to-list').addEventListener('click', () => {
  document.querySelector('.messenger')
    .classList.remove('mobile-chat-open');
});

$('chat-list').addEventListener('click', () => {
  document.querySelector('.messenger')
    .classList.add('mobile-chat-open');
});

// ВЫХОД

$('logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    state.events?.close();
    state.user = null;
    showLogin();
  }
});

// АВТОРИЗАЦИЯ

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();

  $('login-error').textContent = '';

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('email').value,
        password: $('password').value
      })
    });

    await showDashboard(data.user);
  } catch (error) {
    $('login-error').textContent = error.message;
  }
});

// ЗАПУСК

async function init() {
  try {
    const data = await api('/api/auth/me');
    await showDashboard(data.user);
  } catch {
    showLogin();
  }
}

init();


// VD MOBILE CHAT MENU
const mobileChatMenuButton = $('mobile-chat-menu-toggle');
const mobileChatMenu = $('mobile-chat-menu');

function setMobileChatMenuOpen(open) {
  mobileChatMenu.classList.toggle('is-open', open);
  mobileChatMenuButton.setAttribute('aria-expanded', String(open));
}

mobileChatMenuButton.addEventListener('click', () => {
  setMobileChatMenuOpen(
    !mobileChatMenu.classList.contains('is-open')
  );
});

document.addEventListener('click', event => {
  if (!event.target.closest('.conversation-header')) {
    setMobileChatMenuOpen(false);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setMobileChatMenuOpen(false);
});
// END VD MOBILE CHAT MENU
