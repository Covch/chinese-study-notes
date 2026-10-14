# Помощник по изучению китайского языка

Создан с помощью DeepSeek.

Статический сайт-показчик карточек для изучения китайского: список карточек и
экран карточки, где каждое поле закрыто спойлером (сам выбираешь, с какой
стороны повторять).

Формат карточек описан в [CARD_FORMAT.md](CARD_FORMAT.md) — это контракт,
синхронный с логикой наполнения.

## Структура

```
index.html          viewer
css/style.css       оформление (тёмная тема)
js/md.js            парсер карточек (frontmatter + секции "## ...")
js/store.js         localStorage (cl:v1:user, cl:v1:progress)
js/app.js           логика: список, карточка, hash-роутинг
tools/build_index.py  пересборка cards/index.json
cards/              карточки (.md) и индекс index.json
```

## Локальный просмотр

Открывать нужно по http (fetch к `cards/*.md` не работает на `file://`):

```sh
cd git_web
python3 -m http.server 8123
# затем http://localhost:8123/
```

## Как добавить карточку руками

1. Создайте файл `cards/<type>-<sanitized-title>.md` по формату из
   [CARD_FORMAT.md](CARD_FORMAT.md) (frontmatter `title`, `type`, `lesson`,
   `level` + секции `## Заголовок`).

2. Пересоберите индекс:
   
   ```sh
   python3 tools/build_index.py
   ```
   
   Скрипт пересканирует `cards/*.md`, сохранит порядок уже известных путей и
   допишет новые в конец. Сторонних пакетов не требует (только stdlib).

3. Обновите страницу в браузере.

## Пользовательские данные

Прогресс и имя хранятся только в `localStorage` браузера (ключи `cl:v1:user`
и `cl:v1:progress`). Сайт не пишет ничего в репозиторий — он read-only.
