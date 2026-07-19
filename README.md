# Open Cowork

Turn your browser into an agent you talk to. Describe a task in plain English and it reads the page, plans the steps, and does them across your tabs. Your API key stays on your machine. No account, no cloud.

## Start

1. Clone the repo and `cd` into it
2. `npm install && npm run bootstrap && npm run build:all`
3. In Chrome, open `chrome://extensions`, turn on Developer mode, click Load unpacked, and pick the `chrome-extension/` folder
4. Click the Open Cowork icon, open Settings, paste your API key, Save
5. Open a page, press `Ctrl/Cmd+E`, type a task, Run Agent

Use Restricted mode on sites you do not trust.

## Models

The extension bundles the full models.dev catalog (167 providers, 5,578 models) so it works offline. It refreshes from the live API on startup and whenever you change settings. Hit Refresh models in Settings to pull the latest right away. The provider list builds itself from the catalog.

## License

MIT.
