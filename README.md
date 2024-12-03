# LARS - Local Automated Runtime System

LARS is a development tool designed to simplify and automate the local development environment for BSV Blockchain applications. It allows developers to easily execute their Topic Managers and Lookup Services within a dynamically created local deployment of the BSV Overlay Services using `@bsv/overlay-express`. LARS integrates Docker Compose, MySQL, MongoDB, and real-time development feedback to provide an intuitive and efficient workflow.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
  - [Adding LARS to Your Project](#adding-lars-to-your-project)
  - [Starting the Development Environment](#starting-the-development-environment)
- [Setup Guide](#setup-guide)
  - [1. Install System Dependencies](#1-install-system-dependencies)
  - [2. Prepare Your Project](#2-prepare-your-project)
  - [3. Configure ngrok](#3-configure-ngrok)
  - [4. Install LARS](#4-install-lars)
  - [5. Configure Your `package.json`](#5-configure-your-packagejson)
  - [6. Start LARS](#6-start-lars)
- [Project Structure](#project-structure)
- [How LARS Works](#how-lars-works)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Automatic Environment Setup**: Automatically sets up Docker containers for Overlay Express, MySQL, and MongoDB.
- **Dynamic Configuration**: Parses your `deployment-info.json` to configure Topic Managers and Lookup Services.
- **Real-time Feedback**: Provides real-time development feedback and error logging.
- **Hot Reloading**: Watches for changes in your code and reloads the environment as needed.
- **Contract Compilation**: Automatically compiles sCrypt contracts upon changes.

## Prerequisites

Before using LARS, ensure you have the following installed on your system:

- **Node.js**: Version 14 or higher.
- **Docker**: Latest version with Docker Compose plugin.
- **ngrok**: Installed and authenticated with your auth token.
- **Git**: For version control.

## Installation

You can install LARS as a development dependency in your BSV project:

```bash
npm install --save-dev @bsv/lars
```

## Usage

### Adding LARS to Your Project

1. Ensure your project has a `deployment-info.json` file at the root directory.

2. Add a start script to your project's `package.json`:

   ```json
   "scripts": {
     "start": "lars start"
   }
   ```

### Starting the Development Environment

Run the following command to start LARS:

```bash
npm run start
```

This command will:

- Parse your `deployment-info.json` file.
- Check for required system dependencies.
- Start an ngrok tunnel for Overlay Express and display the public URL.
- Generate and start Docker containers for your development environment.
- Watch for file changes and recompile contracts as needed.
- Stream logs from the development container to your terminal.

## Setup Guide

### 1. Install System Dependencies

Ensure you have the following installed:

- **Docker**: [Download and install Docker](https://www.docker.com/get-started).
- **Docker Compose Plugin**: Included with Docker Desktop; ensure it's installed.
- **ngrok**: [Download ngrok](https://ngrok.com/download) and authenticate it with your token:

  ```bash
  ngrok authtoken <your_auth_token>
  ```

### 2. Prepare Your Project

Your project should follow the standard BSV project structure (see below).

Ensure your `deployment-info.json` is correctly configured. Example (from the [Meter](https://github.com/p2ppsr/meter) project):

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
    }
}
```

### 3. Configure ngrok

Authenticate ngrok with your auth token:

```bash
ngrok authtoken <your_auth_token>
```

### 4. Install LARS

Install LARS as a development dependency:

```bash
npm install --save-dev @bsv/lars
```

### 5. Configure Your `package.json`

Add the start script to your root `package.json`:

```json
"scripts": {
  "start": "lars start"
}
```

### 6. Start LARS

Run the start script:

```bash
npm run start
```

## Project Structure

A standard BSV project should have the following structure:

```
| - deployment-info.json
| - package.json
| - local-data/
| - frontend/
  | - package.json
  | - webpack.config.js
  | - src/
  | - public/
| - backend/
  | - package.json
  | - tsconfig.json
  | - mod.ts
  | - src/
    | - contracts/
    | - lookup-services/
    | - topic-managers/
    | - script-templates/
  | - artifacts/
  | - dist/
```

- **deployment-info.json**: Configuration file for your BSV application.
- **local-data/**: Directory used by LARS for generated files and Docker volumes.
- **backend/**: Contains your application's backend code, including contracts, topic managers, and lookup services.
- **frontend/**: Contains your application's frontend code.

## How LARS Works

1. **Parses `deployment-info.json`**: LARS reads your configuration and sets up the environment accordingly.

2. **Checks System Dependencies**: Ensures Docker, Docker Compose, and ngrok are installed and configured.

3. **Starts ngrok Tunnel**: Opens a tunnel to expose your local environment to the internet and retrieves the public URL.

4. **Generates Docker Configuration**: Creates `docker-compose.yml`, `Dockerfile`, and other necessary files in the `local-data` directory.

5. **Builds and Runs Containers**: Uses Docker Compose to build and start the containers for Overlay Express, MySQL, and MongoDB.

6. **Sets Up File Watchers**: Monitors your codebase for changes and triggers recompilation or restarts as needed.

7. **Provides Real-time Feedback**: Streams logs and error messages to your terminal for easy debugging.

## Troubleshooting

- **Docker Issues**: Ensure Docker is running and you have permission to run Docker commands.

- **ngrok Authentication**: If ngrok fails to start, verify your auth token is set correctly.

- **Port Conflicts**: Make sure ports `8080`, `3306`, and `27017` are not in use by other services.

- **File Permissions**: Ensure you have read and write permissions for the `local-data` directory.

- **Missing Dependencies**: Verify that all dependencies are installed in your `backend/package.json`.

## Contributing

Contributions are welcome! Please submit a pull request or open an issue on GitHub.

## License

[Open BSV License](./LICENSE.txt)
