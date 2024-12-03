#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const fs = require('fs-extra');
const ngrok = require('ngrok');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const yaml = require('yaml');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');

program
    .command('start')
    .description('Start LARS development environment')
    .action(async () => {
        try {
            // Step 1: Parse and validate deployment-info.json
            const deploymentInfoPath = path.resolve(process.cwd(), 'deployment-info.json');
            if (!fs.existsSync(deploymentInfoPath)) {
                console.error('deployment-info.json not found in the current directory.');
                process.exit(1);
            }
            const deploymentInfo = JSON.parse(fs.readFileSync(deploymentInfoPath, 'utf-8'));

            // Step 2: Check for system dependencies
            // Check Docker
            try {
                execSync('docker --version', { stdio: 'ignore' });
            } catch (err) {
                console.error('Docker is not installed or not running.');
                process.exit(1);
            }
            // Check Docker Compose
            try {
                execSync('docker compose version', { stdio: 'ignore' });
            } catch (err) {
                console.error('Docker Compose plugin is not installed.');
                process.exit(1);
            }
            // Check ngrok
            try {
                execSync('ngrok version', { stdio: 'ignore' });
            } catch (err) {
                console.error('ngrok is not installed.');
                process.exit(1);
            }

            // Check write access to ./local-data
            const localDataPath = path.resolve(process.cwd(), 'local-data');
            try {
                fs.ensureDirSync(localDataPath);
            } catch (err) {
                console.error('Cannot write to ./local-data directory.');
                process.exit(1);
            }

            // Step 3: Start ngrok and get public URL
            console.log('Starting ngrok...');
            const ngrokUrl = await ngrok.connect({ addr: 8080 });
            console.log(`ngrok tunnel established at ${ngrokUrl}`);

            // Save HOSTING_URL for later use
            const hostingUrl = ngrokUrl;

            // Generate a server private key
            /*
            TODO:
            - Check if a private key is configured in a local-data/server-private-key.txt file
            - If not offer to generate one or have the developer enter one
            - If one is entered use a password entry so as not to display it.
            - Either way once we have a key check its balance using Ninja
            - If balance less than 10000 warn and ask whether to fund, print manual instructions or continue
            - If yes use local MNC to fund
            - If print manual instructions provide KeyFunder instructions and the private key
            */
            const serverPrivateKey = crypto.randomBytes(32).toString('hex');

            // Step 4: Generate docker-compose.yml
            const composeContent = generateDockerCompose(hostingUrl, localDataPath, serverPrivateKey);
            const composeYaml = yaml.stringify(composeContent);
            const composeFilePath = path.join(localDataPath, 'docker-compose.yml');
            fs.writeFileSync(composeFilePath, composeYaml);
            console.log('docker-compose.yml generated.');

            // Step 5: Generate index.ts, package.json, Dockerfile
            const overlayDevContainerPath = path.join(localDataPath, 'overlay-dev-container');
            fs.ensureDirSync(overlayDevContainerPath);

            // Generate index.ts
            const indexTsContent = generateIndexTs(deploymentInfo);
            fs.writeFileSync(path.join(overlayDevContainerPath, 'index.ts'), indexTsContent);

            // Generate package.json
            const backendPackageJsonPath = path.resolve(process.cwd(), 'backend', 'package.json');
            let backendDependencies = {};
            if (fs.existsSync(backendPackageJsonPath)) {
                const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, 'utf-8'));
                backendDependencies = backendPackageJson.dependencies || {};
            } else {
                console.warn('No backend/package.json found.');
            }
            const packageJsonContent = generatePackageJson(backendDependencies);
            fs.writeFileSync(path.join(overlayDevContainerPath, 'package.json'), JSON.stringify(packageJsonContent, null, 2));

            // Generate Dockerfile
            const dockerfileContent = generateDockerfile();
            fs.writeFileSync(path.join(overlayDevContainerPath, 'Dockerfile'), dockerfileContent);

            console.log('overlay-dev-container files generated.');

            // Step 6: Start Docker Compose
            console.log('Starting Docker Compose...');
            const dockerComposeUp = spawn('docker', ['compose', 'up', '--build'], {
                cwd: localDataPath,
                stdio: 'inherit'
            });

            dockerComposeUp.on('exit', (code) => {
                console.log(`Docker Compose exited with code ${code}`);
            });

            // Step 7: Set up file watchers
            const backendSrcPath = path.resolve(process.cwd(), 'backend', 'src');

            const watcher = chokidar.watch(backendSrcPath, { ignoreInitial: true });

            watcher.on('all', (event, filePath) => {
                console.log(`File ${event}: ${filePath}`);

                if (filePath.startsWith(path.join(backendSrcPath, 'contracts'))) {
                    // Run npm run compile in backend
                    console.log('Changes detected in contracts directory. Running npm run compile...');
                    const compileProcess = spawn('npm', ['run', 'compile'], {
                        cwd: path.resolve(process.cwd(), 'backend'),
                        stdio: 'inherit'
                    });

                    compileProcess.on('exit', (code) => {
                        if (code === 0) {
                            console.log('Contract compilation completed.');
                        } else {
                            console.error(`Contract compilation failed with exit code ${code}.`);
                        }
                    });
                }
            });

        } catch (err) {
            console.error('Error starting LARS:', err);
        }
    });

program.parse(process.argv);

// Helper functions
function generateDockerCompose(hostingUrl, localDataPath, serverPrivateKey) {
    const composeContent = {
        version: '3.9',
        services: {
            'overlay-dev-container': {
                build: {
                    context: './overlay-dev-container',
                    dockerfile: 'Dockerfile'
                },
                container_name: 'overlay-dev-container',
                restart: 'always',
                ports: [
                    '8080:8080'
                ],
                environment: {
                    MONGO_URL: 'mongodb://mongo:27017/overlay-db',
                    KNEX_URL: 'mysql://overlayAdmin:overlay123@mysql:3306/overlay',
                    SERVER_PRIVATE_KEY: serverPrivateKey,
                    HOSTING_URL: hostingUrl
                },
                depends_on: [
                    'mysql',
                    'mongo'
                ],
                volumes: [
                    `${path.resolve(localDataPath, 'overlay-dev-container')}:/app`,
                    `${path.resolve(process.cwd(), 'backend')}:/app/backend`
                ]
            },
            mysql: {
                image: 'mysql:8.0',
                container_name: 'overlay-mysql',
                environment: {
                    MYSQL_DATABASE: 'overlay',
                    MYSQL_USER: 'overlayAdmin',
                    MYSQL_PASSWORD: 'overlay123',
                    MYSQL_ROOT_PASSWORD: 'rootpassword'
                },
                ports: [
                    '3306:3306'
                ],
                volumes: [
                    `${path.resolve(localDataPath, 'mysql')}:/var/lib/mysql`
                ],
                healthcheck: {
                    test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
                    interval: '10s',
                    timeout: '5s',
                    retries: 3
                }
            },
            mongo: {
                image: 'mongo:5.0',
                container_name: 'overlay-mongo',
                ports: [
                    '27017:27017'
                ],
                volumes: [
                    `${path.resolve(localDataPath, 'mongo')}:/data/db`
                ],
                healthcheck: {
                    test: ['CMD', 'mongo', '--eval', "db.adminCommand('ping')"],
                    interval: '10s',
                    timeout: '5s',
                    retries: 5
                }
            }
        }
    };
    return composeContent;
}

function generateIndexTs(deploymentInfo) {
    let imports = `
import OverlayExpress from '@bsv/overlay-express'
import dotenv from 'dotenv'
dotenv.config()
`;

    let mainFunction = `
const main = async () => {

    const server = new OverlayExpress(
        \`testnode\`,
        process.env.SERVER_PRIVATE_KEY!,
        process.env.HOSTING_URL!
    )

    server.configurePort(8080)
    await server.configureKnex(process.env.KNEX_URL!)
    await server.configureMongo(process.env.MONGO_URL!)
    server.configureEnableGASPSync(false)
`;

    // For each topic manager
    for (const [name, pathToTm] of Object.entries(deploymentInfo.topicManagers || {})) {
        const importName = `tm_${name}`;
        const pathToTmInContainer = path.join('/app', path.relative(process.cwd(), pathToTm)).replace(/\\/g, '/');
        imports += `import ${importName} from '${pathToTmInContainer}'\n`;
        mainFunction += `    server.configureTopicManager('${name}', new ${importName}())\n`;
    }

    // For each lookup service
    for (const [name, lsConfig] of Object.entries(deploymentInfo.lookupServices || {})) {
        const importName = `lsf_${name}`;
        const pathToLsInContainer = path.join('/app', path.relative(process.cwd(), lsConfig.serviceFactory)).replace(/\\/g, '/');
        imports += `import { serviceFactory as ${importName} } from '${pathToLsInContainer}'\n`;
        if (lsConfig.hydrateWith === 'mongo') {
            mainFunction += `    server.configureLookupServiceWithMongo('${name}', ${importName})\n`;
        } else if (lsConfig.hydrateWith === 'knex') {
            mainFunction += `    server.configureLookupServiceWithKnex('${name}', ${importName})\n`;
        } else {
            mainFunction += `    server.configureLookupService('${name}', ${importName}())\n`;
        }
    }

    mainFunction += `
    await server.configureEngine()
    await server.start()
}

main()
`;

    const indexTsContent = imports + mainFunction;
    return indexTsContent;
}

function generatePackageJson(backendDependencies) {
    const packageJsonContent = {
        "name": "overlay-express-dev",
        "version": "1.0.0",
        "description": "",
        "main": "index.ts",
        "scripts": {
            "start": "tsx watch index.ts"
        },
        "keywords": [],
        "author": "",
        "license": "ISC",
        "dependencies": {
            "@bsv/overlay-express": "^0.1.6",
            "dotenv": "^16.4.5",
            "mysql2": "^3.11.5",
            "tsx": "^4.19.2",
            ...backendDependencies
        },
        "devDependencies": {
            "@types/node": "^22.10.1"
        }
    };
    return packageJsonContent;
}

function generateDockerfile() {
    return `
# Use an official Node.js runtime as the base image
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Expose the application port
EXPOSE 8080

# Start the application
CMD ["sh", "-c", "cd /app/backend && npm install && cd /app && npm start"]
`;
}
