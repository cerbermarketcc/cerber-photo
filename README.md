# Cerber Anonim Photo

Простой сайт для загрузки фото и выдачи постоянной ссылки на каждую фотографию.

## Локальный запуск

```bash
npm start
```

Открой:

```text
http://localhost:3000
```

## Render

Для постоянного хранения фото на Render нужно одно из двух:

1. Render Persistent Disk: подключить диск и поставить переменную `UPLOAD_DIR=/var/data/uploads`.
2. Внешнее хранилище: Cloudflare R2, AWS S3, Backblaze B2 или Supabase Storage.

Без persistent disk или внешнего storage Render может удалить загруженные фото при перезапуске сервиса.

Рекомендуемые настройки Render:

```text
Build Command: npm install
Start Command: npm start
Environment: Node
UPLOAD_DIR: /var/data/uploads
```
