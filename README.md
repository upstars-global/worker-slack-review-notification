# Slack Review Reminder — Cloudflare Worker

Автоматический бот для Slack, который проверяет сообщения с меткой **"code review"** в заданном канале и публикует напоминания в тред, если на сообщении меньше 2 реакций (эмоджи).

---

## 🚀 Функциональность

1. Проверяет сообщения за последние 5 дней через Slack API (`conversations.history`).
2. Фильтрует только сообщения, начинающиеся с `code review`.
3. Считает общее количество реакций (`reactions[].count`).
4. Если реакций меньше 2 и в треде не было активности последние 3 часа:
    - Публикует напоминание в тред через `chat.postMessage`.
    - (опционально) Упоминает группу пользователей `@usergroup` через `<!subteam^ID>`.
5. Работает **по cron** (по расписанию) и **по запросу** через HTTP `POST /run`.

---

## 🧩 Требуемые права Slack App

Создайте приложение на [api.slack.com/apps](https://api.slack.com/apps) и установите его в ваш workspace.

Минимальные **Bot Token Scopes**:

chat:write
channels:read
conversations.history
reactions:read
usergroups:read

Копировать код

Для приватных каналов добавьте:

groups:read
groups:history

markdown
Копировать код

После установки получите токен вида `xoxb-1234567890-abcdef`.

---

## ⚙️ Переменные окружения

| Переменная | Описание | Обязательно |
|-------------|-----------|--------------|
| `SLACK_BOT_TOKEN` | OAuth токен бота | ✅ |
| `SLACK_CHANNEL_ID` | ID канала (например, `C04ABC123`) | ✅ |
| `REMINDER_TEXT` | Текст напоминания | ❌ |
| `GROUP_HANDLE` | handle группы для упоминания (без `@`) | ❌ |
| `WORK_TZ` | Таймзона (по умолчанию `Europe/Kyiv`) | ❌ |

### Пример `.env` (для локального теста)
```
SLACK_BOT_TOKEN=xoxb-1234567890
SLACK_CHANNEL_ID=C04ABC123
REMINDER_TEXT="Пожалуйста, добавьте минимум 2 реакции для ревью"
GROUP_HANDLE=frontend_team
WORK_TZ=Europe/Kyiv
```

### 🧠 Как получить SLACK_CHANNEL_ID<
Откройте канал в Slack.

Посмотрите в URL:
https://app.slack.com/client/T01234567/C04ABC123 → SLACK_CHANNEL_ID=C04ABC123 

Или:

Channel menu → Copy channel link → возьмите часть после /archives/.

## 🏗️ Деплой в Cloudflare Workers
1. Установка Wrangler
```bash
npm install -g wrangler
```
2. Инициализация проекта
```bash
mkdir slack-review-reminder
cd slack-review-reminder
wrangler init --type=module
```
Скопируйте в src/worker.ts содержимое основного скрипта.

3. Настройка wrangler.toml
``` toml
name = "slack-review-reminder"
main = "src/worker.ts"
compatibility_date = "2025-10-14"

[triggers]
crons = [ "0 * * * *" ] # Запуск каждый час

[vars]
WORK_TZ = "Europe/Kyiv"
```
4. Добавление секретов
```bash
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_CHANNEL_ID
wrangler secret put REMINDER_TEXT
wrangler secret put GROUP_HANDLE
```
5. Деплой
```bash
wrangler deploy
```

🧾 Ручной запуск
После деплоя можно запустить вручную:

```bash
curl -X POST https://<your-worker-subdomain>.workers.dev/run
```
```bash
curl https://<your-worker-subdomain>.workers.dev/health
```

## 🕒 Логика расписания
- Скрипт запускается по cron (scheduled handler).
- Работает только в будни (Пн–Пт).
- Пропускает ночные часы (до 8:00 и после 20:00).
- Проверяет активность треда за последние 3 часа.

### 🧩 Как работает
- Получает историю канала за 5 дней (conversations.history).
- Ищет сообщения, начинающиеся с code review.
- Считает общее количество реакций (reaction.count).
- Если меньше 2 реакций → проверяет активность треда через conversations.replies.
- При отсутствии активности публикует сообщение в тред с REMINDER_TEXT.

###  🧰 Тестирование локально
```bash
wrangler dev --test-scheduled
```
```bash

# или ручной HTTP вызов:
wrangler dev
curl -X POST http://localhost:8787/run
```
#### 📈 Пример лога выполнения
```json
{
  "sent": 3,
  "skipped": 27
}
```


___
(C) 📚 Источники
- [Slack Web API Docs](https://api.slack.com/web)
- [Slack conversations.history](https://api.slack.com/methods/conversations.history) 
- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers) 
- [Wrangler Environment Variables & Secrets](https://developers.cloudflare.com/workers/configuration/environment-variables)
