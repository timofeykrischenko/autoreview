# autoreview

Авторевью PR через Claude на self-hosted раннере `claude-review`. Ревью живет в одном комментарии на язык и обновляется на каждом пуше.

Комментарий устроен так:

- первый прогон пишет полное ревью;
- каждый следующий прогон пишет сверху резюме PR на текущий коммит (что еще открыто), под ним спойлер с первым ревью и двумя последними итерациями, в конце изменения этого коммита.

## Подключение

```yaml
name: Claude auto-review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: claude-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: [self-hosted, claude-review]
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Run Claude auto-review
        uses: timofeykrischenko/autoreview@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          atlassian-email: ${{ secrets.ATLASSIAN_EMAIL }}
          atlassian-api-token: ${{ secrets.ATLASSIAN_API_TOKEN }}
```

## Параметры

| Параметр | По умолчанию | Назначение |
|---|---|---|
| `github-token` | | токен для чтения PR и записи комментария |
| `atlassian-email`, `atlassian-api-token` | пусто | доступ к Jira и Confluence, без них ревью идет без контекста задачи |
| `atlassian-base-url` | `https://535media.atlassian.net` | |
| `jira-project-prefix` | `DFUSION` | префикс ключа задачи в ветке или заголовке PR |
| `languages` | `ru` | языки через запятую, на каждый отдельный комментарий (`ru,en` в биддере) |
| `review-notes` | пусто | строки, которые добавляются к правилам промпта для конкретного репозитория |
| `linear-api-key` | пусто | ключ Linear API, без него задачи Linear не подтягиваются |
| `linear-team-prefix` | пусто | ключи команд Linear через запятую, например `ELEV,HAL` |
| `google-sa-key` | пусто | JSON-ключ сервисного аккаунта Google с доступом к документам задачи |

Стандарты берутся из `CLAUDE.md` репозитория и Confluence-страниц, на которые он ссылается.

Контекст задачи ищется по ключу в ветке или заголовке PR: сначала ключ команды Linear из `linear-team-prefix`, потом ключ Jira. Из Linear берутся задача, родитель, проект, вложения и Google Docs по ссылкам из них; свёрнутый блок «RU Version (auto-translated)» отбрасывается. Ключи Atlassian, Linear и Google в окружение Claude не передаются.

С Linear и двумя языками:

```yaml
      - name: Run Claude auto-review
        uses: timofeykrischenko/autoreview@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          languages: ru,en
          linear-api-key: ${{ secrets.LINEAR_API_KEY }}
          linear-team-prefix: ELEV,HAL
          google-sa-key: ${{ secrets.GOOGLE_SA_KEY }}
```
