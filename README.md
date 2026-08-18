# Cerber Anonim Photo

Сайт для анонимной загрузки фото и выдачи приватной ссылки на каждую фотографию.

## Приватность

- В ссылке используется отдельный 256-битный ключ после `#`. Эта часть URL не отправляется в HTTP-запросе и не попадает в обычные журналы сервера.
- Сервер хранит только SHA-256 хеш ключа, а не сам ключ.
- После проверки ключа браузер получает короткую `HttpOnly`, `SameSite=Strict` сессию. Прямой `/image/<id>` без неё возвращает `404`.
- Изображения отдаются с `Cache-Control: private, no-store` и не могут встраиваться с другого сайта.
- Старые публичные ссылки автоматически отзываются. Сами файлы сохраняются, а новые ключи восстановления записываются в закрытый файл `.legacy-photo-keys.json` внутри `UPLOAD_DIR`.

Приватную ссылку следует передавать только тому, кому разрешён просмотр. Любой получивший полную ссылку с `#key=...` сможет открыть фотографию.

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
PHOTO_SESSION_SECRET: случайная строка длиной не меньше 32 символов
```

Если `PHOTO_SESSION_SECRET` не задан, сервер создаёт его сам в закрытом файле внутри `UPLOAD_DIR`. Для нескольких экземпляров сервиса необходимо задать одинаковое значение через секретную переменную окружения.

Дополнительные ограничения:

```text
MAX_UPLOAD_BYTES=26214400
MAX_FILE_BYTES=10485760
MAX_FILES_PER_UPLOAD=20
MAX_STORAGE_BYTES=2147483648
UPLOAD_RATE_LIMIT=10
UPLOAD_RATE_WINDOW_MS=600000
ACCESS_RATE_LIMIT=30
ACCESS_RATE_WINDOW_MS=60000
PHOTO_SESSION_TTL_SECONDS=3600
```

## Проверка

```bash
npm run build
npm test
```
