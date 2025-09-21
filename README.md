# Local RAG Indexer for Codebases

TypeScript утилита индексации репозитория с локальными эмбеддингами (Ollama `nomic-embed-text`) и поиском через Meilisearch user-provided vectors — по аналогии с поведением Cursor.

## Требования
- Node.js ≥ 18
- npm ≥ 9
- Docker (для Meilisearch)
- [Ollama](https://ollama.com/) с моделью `nomic-embed-text` (`ollama pull nomic-embed-text`)

## Структура
- `src/embed.ts` — выбор эмбеддеров (`transformers` или `ollama`, по умолчанию `ollama`).
- `src/indexer.ts` — построение/обновление индекса, наблюдение за файловой системой.
- `src/search.ts` — CLI-поиск по Meilisearch.
- `src/serve.ts` — единый серверный процесс: запускает Meilisearch в Docker, включает vector store, переиндексирует репозиторий, поднимает watcher и HTTP-API для поиска.
- `.env.example` — переменные окружения (Meilisearch, корень репозитория, backend эмбеддингов).

## Установка
```bash
npm install
cp .env.example .env
```
При необходимости скорректируйте значения в `.env`.

## Быстрый старт одной командой
```bash
npm run serve -- \
  --root . \
  --index repo \
  --meili-port 7700 \
  --api-port 3333
```

Что делает `serve`:
- создаёт (при необходимости) директорию `.meili-data` внутри проекта и монтирует её в Docker-контейнер Meilisearch;
- поднимает контейнер с образом `getmeili/meilisearch:v1.10`, включает experimental vector store;
- выполняет полную индексацию репозитория, запускает watcher для инкрементальных обновлений;
- открывает HTTP-API (по умолчанию `http://127.0.0.1:3333`) с ручками:
  - `GET /search?q=...&limit=` — семантический поиск;
  - `POST /search` — аналогично, тело `{ "query": "...", "limit": 5 }`;
  - `POST /reindex` — форсировать полную переиндексацию;
  - `GET /health` — состояние сервера и краткая статистика индекса.

Параметры можно задавать через CLI или переменные окружения (`--backend`, `--ollama-model`, `--meili-host`, `--data-dir`, `--container-name` и т.д.). После остановки сервера контейнер и watcher завершаются, а база остаётся в `.meili-data/`.

### Проверка состояния базы и индекса
В любой момент можно получить сводку по текущему индексу и хранилищу:
```bash
npm run status -- \
  --meili-url http://127.0.0.1:7700 \
  --index repo \
  --root .
```
Команда покажет количество документов (чанков), распределение по полям, флаг `isIndexing`, список последних задач Meilisearch и размер каталога с базой (`.meili-data` по умолчанию). Параметры те же, что и у `serve`.

## Запуск Meilisearch (ручной режим)
```bash
docker run -d \
  --name meilisearch-rag \
  -p 7700:7700 \
  -e MEILI_MASTER_KEY=devkey \
  getmeili/meilisearch:v1.10
```
Активируем vector store (обязательно для user-provided embeddings):
```bash
curl -s -X PATCH http://127.0.0.1:7700/experimental-features \
  -H 'Authorization: Bearer devkey' \
  -H 'Content-Type: application/json' \
  --data '{"vectorStore": true}'
```

### Хранение данных Meilisearch рядом с проектом
Создайте директорию и примонтируйте её как volume:
```bash
mkdir -p .meili-data

docker run -d \
  --name meilisearch-rag \
  -p 7700:7700 \
  -e MEILI_MASTER_KEY=devkey \
  -v $(pwd)/.meili-data:/meili_data \
  getmeili/meilisearch:v1.10
```
Так индекс (включая вектора) останется внутри папки `.meili-data` и может храниться вместе с репозиторием (эта папка уже добавлена в `.gitignore`).

## Индексация (ручной режим)
```bash
MEILI_URL=http://127.0.0.1:7700 \
MEILI_KEY=devkey \
INDEX_UID=repo \
RAG_EMBED_BACKEND=ollama \
npm run index:once
```
Команда построит чанки (по умолчанию 150 строк, 30 строк перекрытия), вычислит эмбеддинги через Ollama и добавит документы в индекс `repo`.

### Инкрементальные обновления (ручной режим)
```bash
MEILI_URL=http://127.0.0.1:7700 \
MEILI_KEY=devkey \
INDEX_UID=repo \
RAG_EMBED_BACKEND=ollama \
npm run index:watch
```
Watcher отслеживает изменения файлов, игнорирует пути из `.gitignore`/`.ragignore`, переиндексирует только изменившиеся чанки и удаляет устаревшие.

> Эти команды пригодятся, если вы предпочитаете управлять инфраструктурой вручную. Скрипт `npm run serve` выполняет те же шаги автоматически.

## Поиск
CLI-поиск из проекта:
```bash
MEILI_URL=http://127.0.0.1:7700 \
MEILI_KEY=devkey \
INDEX_UID=repo \
RAG_EMBED_BACKEND=ollama \
npm run search -- "инициализация БД"
```
Флаги: `--limit N`, `--json`.

### Поиск через curl (fish shell пример)
```fish
set query "инициализация БД"
set vector (jq -n --arg prompt "$query" '{model:"nomic-embed-text", prompt:$prompt}' \
  | curl -s http://127.0.0.1:11434/api/embeddings \
      -H 'Content-Type: application/json' \
      --data-binary @- \
  | jq -c '.embedding' \
  | string trim)

curl -s -X POST http://127.0.0.1:7700/indexes/repo/search \
  -H 'Authorization: Bearer devkey' \
  -H 'Content-Type: application/json' \
  -d '{"limit":5,"vector":'$vector'}' | jq
```

## Как работает индексация
1. Определяем список файлов (`walk`) с учётом `.gitignore`, `.ragignore`, ограничений по размеру и расширениям.
2. Читаем файлы, нарезаем по строкам (150 строк, перекрытие 30) — каждый чанк получает стабильный `id = sha256(file:path:start:end:hash)`. Так изменяются только затронутые чанки.
3. Передаём текст чанков в эмбеддер (Ollama `nomic-embed-text` → 768-dim векторы).
4. Сохраняем документы в Meilisearch (`filePath`, диапазон строк, текст, `_vectors.code`). Удаляем устаревшие документы файла, если содержимое изменилось.
5. Для поиска запрос эмбеддится тем же backend, делается POST `/indexes/<uid>/search` с полем `vector` и `limit`. Meilisearch возвращает топ-k чанков.

## Переменные окружения
- `MEILI_URL`, `MEILI_KEY`, `INDEX_UID` — настройки Meilisearch.
- `REPO_ROOT` — корень проекта (по умолчанию `.`).
- `RAG_EMBED_BACKEND` — `ollama` (по умолчанию) или `transformers`.
- `RAG_OLLAMA_MODEL` — название модели Ollama.
- `RAG_CHUNK_LINES`, `RAG_CHUNK_OVERLAP`, `RAG_MAX_FILE_BYTES` — настройки чанкинга/фильтра файлов.

## Очистка и переиндексация
- Сбросить индекс: `curl -X DELETE http://127.0.0.1:7700/indexes/repo -H 'Authorization: Bearer devkey'` и заново выполнить `index:once`.
- Очистить хранилище: `docker rm -f meilisearch-rag && rm -rf .meili-data` (если данные держите локально).

## Комбинация с другими бэкендами
- Чтобы использовать `@huggingface/transformers`, установите модель `Xenova/bge-small-en-v1.5` (по умолчанию) и выставьте `RAG_EMBED_BACKEND=transformers`.
- Можно добавить новые backends, реализовав их в `src/embed.ts`.

Готовый набор скриптов позволяет повторять поведение Cursor локально: индекс хранится в Meilisearch, эмбеддинги вычисляются локально, а поиск возвращает релевантные куски кода.
