# LARS - Local Automated Runtime System

LARS is a command-line interface and development tool that simplifies running and managing your BSV Overlay Services locally. It automates the creation and configuration of a local development environment, leveraging `@bsv/overlay-express` behind the scenes, along with Docker, MySQL, MongoDB, and ngrok. LARS complements the production-focused CARS (Cloud Automated Runtime System), enabling a smooth path from local development to cloud deployments.

## Overview

LARS enables you to:

- **Quickly configure a local development environment** for BSV applications using your `deployment-info.json` file.
- **Interactively manage keys and settings** such as server private keys and TAAL (ARC) API keys, distinct per network (mainnet/testnet).
- **Seamlessly run OverlayExpress services** with automatic Docker Compose setup, MySQL, and MongoDB.
- **Run both backend and frontend services** based on your configuration. LARS will automatically start a local frontend (e.g., React or static HTML) if specified, and ensure frontend dependencies are installed if necessary.
- **Hot-reload contracts and code** as you develop, with automatic recompilation of sCrypt contracts when they change.
- **Easily switch networks (mainnet or testnet)** and control environment-level logging and synchronization features (like GASP sync).

LARS is designed to make local development as frictionless as possible, guiding you through necessary setup steps, keys configuration, environment preparation, and now also handling your frontend environment if desired.

## Key Features

- **Interactive Menus**: Running `lars` with no arguments launches interactive menus for configuring global keys, project configs, deployment info, or starting your local environment.
- **Separation of Keys by Network**: Maintain distinct keys (server private keys, TAAL API keys) for mainnet and testnet, both globally and at the project level.
- **Automatic Environment Setup**: LARS creates a local Docker-based environment for your backend, including `overlay-express`, MySQL, and MongoDB.
- **Frontend Integration**: If configured, LARS can also run your frontend (e.g., React). It automatically installs missing dependencies and starts the frontend. If you're running both backend and frontend, LARS waits until the backend is ready before starting the frontend.
- **ngrok Integration**: Securely expose your local environment to the internet for testing or external integration.
- **Hot Reloading & Real-Time Feedback**: Watches code changes, recompiles sCrypt contracts, and provides immediate feedback in the terminal.
- **Smooth Transition from Local to Cloud**: LARS mirrors the structure and concepts of CARS, making it easy to move from local development (LARS) to production deployment (CARS).

## Prerequisites

Before using LARS, ensure you have:

- **Node.js**: Version 20 or higher recommended.
- **Docker**: With the Docker Compose plugin (Docker Desktop or Docker Engine + Compose Plugin).
- **ngrok**: Installed and authenticated with your auth token.
- **MetaNet Client**: For funding local Ninja keys if needed ([Download MetaNet Client](https://projectbabbage.com/)).
- **Git**: For version control (optional but recommended).

You should also have a valid `deployment-info.json` at your project's root directory, describing your topic managers, lookup services, frontend, contracts, and LARS configuration.

## Installation

Install LARS as a development dependency in your BSV project:

```bash
npm install --save-dev @bsv/lars
```

This installs the `lars` command locally. You can also install it globally if you prefer, but local installation is often best for reproducible environments.

## Usage

### 1. Prepare Your Project

Ensure your project contains `deployment-info.json` in the root directory. For example:

```json
{
  "schema": "bsv-app",
  "schemaVersion": "1.0",
  "topicManagers": {
    "tm_meter": "./backend/src/topic-managers/MeterTopicManager.ts"
  },
  "lookupServices": {
    "ls_meter": {
      "serviceFactory": "./backend/src/lookup-services/MeterLookupServiceFactory.ts",
      "hydrateWith": "mongo"
    }
  },
  "frontend": {
    "language": "react",
    "sourceDirectory": "./frontend"
  },
  "contracts": {
    "language": "sCrypt",
    "baseDirectory": "./backend"
  },
  "configs": [
    {
      "name": "Local LARS",
      "network": "testnet",
      "provider": "LARS",
      "run": ["backend"]
    }
  ]
}
```

The `configs` section includes a LARS configuration. If none exists, LARS will guide you through creating one. The `run` array controls which services are started: `["backend"]`, `["frontend"]`, or both `["backend", "frontend"]`.

### 2. Start LARS Interactively

Running `lars` with no arguments opens the main menu:

```bash
npx lars
```

(If installed globally, just use `lars`.)

You’ll see options to edit global keys, project configs, deployment info, or start the environment. If you have no LARS config, it will guide you to create one. The menus help you set or generate server keys, configure TAAL ARC API keys (if desired), choose your network, and select which services to run.

### 3. Configure Keys and Settings

- **Global Keys**: Stored in `~/.lars-keys.json`, reusable across projects.
- **Project-Level Keys**: Stored in `local-data/lars-config.json` within your project. Allows overriding keys for this project.
- **Per Network**: Manage separate keys and settings for mainnet and testnet. LARS will prompt if something’s missing.

If no keys are found, LARS will prompt you to set them. You can hoist newly set project-level keys to global keys for reuse.

### 4. Start the Local Environment

From the main menu, or by running `lars start`, LARS will:

- Check system dependencies (Docker, Compose, ngrok, MetaNet Client).
- Start an ngrok tunnel to expose your local OverlayExpress instance.
- Generate Docker Compose files and an environment tailored to your `deployment-info.json`.
- If `run` includes `backend`, launch Docker containers for OverlayExpress, MySQL, and MongoDB.
- If `run` includes `frontend`, start your frontend application (e.g., React) after ensuring dependencies are installed. If both backend and frontend are selected, LARS waits until the backend is ready before starting the frontend.
- Watch for code changes, recompile sCrypt contracts, and reload services as needed.

When running, LARS displays logs and updates in real-time. Make changes in `backend/src/` or your frontend directory, and see them reflected immediately.

### 5. Switching Networks or Editing Deployment Info

Need to switch from testnet to mainnet, or vice versa? Just run:

```bash
npx lars
```

Go to "Edit LARS Deployment Info" and select "Change network." LARS updates `deployment-info.json` accordingly. You can also edit which services run (backend, frontend, or both) through the "Edit LARS Deployment Info" menu.

### 6. Funding Your Server Key (Optional)

If your server key’s Ninja wallet balance is low, LARS offers automatic funding via MetaNet Client or instructions for manual funding. Keep at least 10,000 satoshis for stable local operation.

### 7. Advanced Overlay Configuration & Admin Tools

LARS now supports **advanced engine configuration** for `@bsv/overlay-express`. Through the “Advanced Overlay Engine Config” menu, you can:

- **Set an admin Bearer token** (`adminToken`) so that you can make use of secured routes like GASP sync or advertisement sync.
- **Control SPV broadcast behavior** via `throwOnBroadcastFailure`.
- **Enable or disable logging timers** (`logTime`) and set a custom `logPrefix`.
- **Fine-tune sync configuration** for each topic through `syncConfiguration`, specifying endpoints, disabling sync (`false`), or using `'SHIP'` for global peer discovery.

Additionally, the **Admin Tools Menu** lets you invoke the admin-protected routes on your local OverlayExpress instance:

- **Sync Advertisements**: Calls `/admin/syncAdvertisements` to ensure local ads match your configured topics and services.
- **Start GASP Sync**: Calls `/admin/startGASPSync` to trigger a manual GASP synchronization.

If you set a custom `adminToken`, LARS will use it for these admin route calls; otherwise, you’ll be prompted to enter one on demand if your server has auto-generated a random token at runtime. Setting a custom one in your config is usually the best bet.

## Project Structure

A standard BSV project might look like:

```
| - deployment-info.json
| - package.json
| - local-data/
| - frontend/
|   | - package.json
|   | - src/
|   | - public/
| - backend/
|   | - package.json
|   | - tsconfig.json
|   | - src/
|     | - topic-managers/
|     | - lookup-services/
|     | - contracts/
|     | - ...
|   | - artifacts/
```

- **deployment-info.json**: Describes your managers, services, frontend, contracts, and configurations (including what LARS runs).
- **local-data/**: LARS generates Docker and environment files here.
- **backend/**: Backend code, contracts, and compiled artifacts.
- **frontend/**: Frontend code (if `run` includes frontend).

## How LARS Works

1. **Reads `deployment-info.json`** to understand your services, configs, network, and which services (backend/frontend) to run.
2. **Guides you through setup** (keys, network selection, etc.) via interactive menus.
3. **Starts ngrok** to provide a public tunnel URL for testing.
4. **Generates Docker files** and runs backend containers if requested.
5. **Installs and starts frontend** if configured, and waits for backend readiness if both are selected.
6. **Watches code** and automatically recompiles contracts and restarts services on changes.
7. **Provides a smooth path to CARS**, so you can use a similar workflow in the cloud.

## Tips & Troubleshooting

- **Port Conflicts**: LARS uses ports `8080` (app), `3306` (MySQL), and `27017` (MongoDB). Ensure these aren’t in use.
- **Network Keys**: If you switch networks, remember that keys are distinct for mainnet and testnet. LARS will prompt if something’s missing.
- **TAAL ARC Key**: If you set a TAAL API key for ARC, get it from [taal.com](https://taal.com/). Keep in mind it may differ between mainnet and testnet if required.
- **Frontend Setup**: If you selected `frontend` and your frontend is React-based, LARS will automatically run `npm install` if `node_modules` is missing. For static HTML, it uses `serve` to host your files.
- **No `deployment-info.json`**: LARS can help you create a basic one if not present.
- **Using LARS and CARS**: LARS is for local dev. CARS handles cloud deployments. They use a shared `deployment-info.json` structure, making transitions easier.

## Contributing

Feedback and contributions are welcome! Please open issues or PRs on the LARS repository.

## License

[Open BSV License](./LICENSE.txt)
