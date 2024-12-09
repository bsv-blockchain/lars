#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const fs = require('fs-extra');
const ngrok = require('ngrok');
const { spawn, execSync } = require('child_process');
const chokidar = require('chokidar');
const yaml = require('yaml');
const os = require('os');
const crypto = require('crypto');
const { Ninja } = require('ninja-base');
const { getPublicKey, createAction, getVersion } = require('@babbage/sdk-ts');
const { P2PKH, PrivateKey, PublicKey } = require('@bsv/sdk');
const figlet = require('figlet');

const LOCAL_DATA_PATH = path.resolve(process.cwd(), 'local-data');
const LARS_CONFIG_PATH = path.join(LOCAL_DATA_PATH, 'lars-config.json');
const DEPLOYMENT_INFO_PATH = path.resolve(process.cwd(), 'deployment-info.json');

// Default config structure
function getDefaultConfig() {
    return {
        serverPrivateKey: null,
        arcApiKey: null,
        enableRequestLogging: true,
        enableGASPSync: false
    };
}

// Load or create config
async function loadOrCreateConfig(interactive = true) {
    const { default: chalk } = await import('chalk');
    const { default: inquirer } = await import('inquirer');

    // If config exists, load it
    if (fs.existsSync(LARS_CONFIG_PATH)) {
        const existingConfig = JSON.parse(fs.readFileSync(LARS_CONFIG_PATH, 'utf-8'));
        return { ...getDefaultConfig(), ...existingConfig };
    }

    if (!interactive) {
        return getDefaultConfig();
    }

    // If no config, prompt user to create it
    console.log(chalk.yellow('⚠️ No LARS config found. Let\'s create one!'));

    // Prompt for server private key
    let serverPrivateKey;
    const { action: keyAction } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Do you want to generate a new private key or enter an existing one?',
            choices: ['🔑 Generate new key', '✏️ Enter existing key'],
        },
    ]);

    if (keyAction === '🔑 Generate new key') {
        serverPrivateKey = crypto.randomBytes(32).toString('hex');
        console.log(chalk.green('✨ New private key generated.'));
    } else {
        const { enteredKey } = await inquirer.prompt([
            {
                type: 'password',
                name: 'enteredKey',
                message: 'Enter your private key (64-char hex):',
                mask: '*',
                validate: function (value) {
                    if (/^[0-9a-fA-F]{64}$/.test(value)) {
                        return true;
                    }
                    return 'Please enter a valid 64-character hexadecimal string.';
                },
            },
        ]);
        serverPrivateKey = enteredKey.toLowerCase();
        console.log(chalk.green('🔐 Private key set.'));
    }

    // Prompt for ARC API key (optional)
    const { setArcKey } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'setArcKey',
            message: 'Do you have an ARC API key to set? (optional)',
            default: false
        }
    ]);

    let arcApiKey = null;
    if (setArcKey) {
        const { enteredArcKey } = await inquirer.prompt([
            {
                type: 'input',
                name: 'enteredArcKey',
                message: 'Enter your ARC API key:',
            },
        ]);
        arcApiKey = enteredArcKey.trim();
        console.log(chalk.green('🔑 ARC API key set.'));
    }

    // Prompt for request logging
    const { enableRequestLogging } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'enableRequestLogging',
            message: 'Enable request logging in Overlay Express?',
            default: true
        }
    ]);

    // Prompt for GASP sync
    const { enableGASPSync } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'enableGASPSync',
            message: 'Enable GASP sync?',
            default: false
        }
    ]);

    const newConfig = {
        serverPrivateKey,
        arcApiKey,
        enableRequestLogging,
        enableGASPSync
    };

    fs.ensureDirSync(LOCAL_DATA_PATH);
    fs.writeFileSync(LARS_CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    console.log(chalk.green('✅ LARS config created.'));

    return newConfig;
}

// Edit config interactively
async function editConfig() {
    const { default: chalk } = await import('chalk');
    const { default: inquirer } = await import('inquirer');

    if (!fs.existsSync(LARS_CONFIG_PATH)) {
        console.log(chalk.yellow('⚠️ No LARS config found. Creating a new one...'));
        await loadOrCreateConfig();
    }

    const config = JSON.parse(fs.readFileSync(LARS_CONFIG_PATH, 'utf-8'));
    const ninja = new Ninja({ privateKey: config.serverPrivateKey });
    let { total: balance } = await ninja.getTotalValue();

    // Interactive menu
    const choices = [
        { name: 'View/change server private key', value: 'key' },
        { name: `View/change ARC API key (current: ${config.arcApiKey ? 'set' : 'not set'})`, value: 'arc' },
        { name: `Toggle request logging (current: ${config.enableRequestLogging ? 'enabled' : 'disabled'})`, value: 'reqlog' },
        { name: `Toggle GASP sync (current: ${config.enableGASPSync ? 'enabled' : 'disabled'})`, value: 'gasp' },
        { name: `Check/fund server balance (current balance: ${balance} satoshis)`, value: 'fund' },
        { name: 'Save and exit', value: 'save' }
    ];

    let done = false;
    while (!done) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'LARS Configuration Menu',
                choices
            }
        ]);

        if (action === 'key') {
            const { action: keyAction } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: 'Set a new private key or generate one?',
                    choices: ['🔑 Generate new key', '✏️ Enter existing key', 'Cancel']
                }
            ]);

            if (keyAction === '🔑 Generate new key') {
                config.serverPrivateKey = crypto.randomBytes(32).toString('hex');
                console.log(chalk.green('✨ New private key generated.'));
            } else if (keyAction === '✏️ Enter existing key') {
                const { enteredKey } = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'enteredKey',
                        message: 'Enter your private key (64-char hex):',
                        mask: '*',
                        validate: function (value) {
                            if (/^[0-9a-fA-F]{64}$/.test(value)) {
                                return true;
                            }
                            return 'Please enter a valid 64-character hexadecimal string.';
                        },
                    },
                ]);
                config.serverPrivateKey = enteredKey.toLowerCase();
                console.log(chalk.green('🔐 Private key set.'));
            }
            // Update ninja and balance after key change
            const ninjaNew = new Ninja({ privateKey: config.serverPrivateKey });
            balance = (await ninjaNew.getTotalValue()).total;
            choices[4].name = `Check/fund server balance (current balance: ${balance} satoshis)`;
        } else if (action === 'arc') {
            const { enteredArcKey } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'enteredArcKey',
                    message: 'Enter your ARC API key (leave blank to unset):',
                },
            ]);
            config.arcApiKey = enteredArcKey.trim() || null;
            console.log(chalk.green('🔑 ARC API key updated.'));
            choices[1].name = `View/change ARC API key (current: ${config.arcApiKey ? 'set' : 'not set'})`;
        } else if (action === 'reqlog') {
            config.enableRequestLogging = !config.enableRequestLogging;
            console.log(chalk.green(`Request logging is now ${config.enableRequestLogging ? 'enabled' : 'disabled'}.`));
            choices[2].name = `Toggle request logging (current: ${config.enableRequestLogging ? 'enabled' : 'disabled'})`;
        } else if (action === 'gasp') {
            config.enableGASPSync = !config.enableGASPSync;
            console.log(chalk.green(`GASP sync is now ${config.enableGASPSync ? 'enabled' : 'disabled'}.`));
            choices[3].name = `Toggle GASP sync (current: ${config.enableGASPSync ? 'enabled' : 'disabled'})`;
        } else if (action === 'fund') {
            if (balance < 10000) {
                console.log(chalk.red(`⚠️  Your server's balance is low: ${balance} satoshis.`));
                const { action: fundAction } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'action',
                        message: 'Your server\'s balance is low. What would you like to do?',
                        choices: [
                            '💰 Fund server automatically (using local MetaNet Client)',
                            '📝 Print manual funding instructions',
                            '🚀 Continue without funding'
                        ],
                    },
                ]);

                if (fundAction === '💰 Fund server automatically (using local MetaNet Client)') {
                    const { amountToFund } = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'amountToFund',
                            message: 'Enter the amount to fund (in satoshis):',
                            default: '30000',
                            validate: function (value) {
                                const valid = !isNaN(parseInt(value)) && parseInt(value) > 0;
                                return valid || 'Please enter a positive number.';
                            },
                            filter: Number,
                        },
                    ]);
                    const ninjaFunder = new Ninja({ privateKey: config.serverPrivateKey });
                    await fundNinja(ninjaFunder, amountToFund, config.serverPrivateKey);
                    console.log(chalk.green(`🎉 Server funded with ${amountToFund} satoshis.`));
                    balance = (await ninjaFunder.getTotalValue()).total;
                    choices[4].name = `Check/fund server balance (current balance: ${balance} satoshis)`;
                } else if (fundAction === '📝 Print manual funding instructions') {
                    console.log(chalk.blue('\nManual Funding Instructions:'));
                    console.log('1. Use KeyFunder to fund your server.');
                    console.log(`2. Your server's Ninja private key is: ${config.serverPrivateKey}`);
                    console.log('3. Visit https://keyfunder.babbage.systems and follow the instructions.');
                    await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'wait',
                            message: 'Press enter when you\'re ready to continue.',
                        },
                    ]);
                } else {
                    console.log(chalk.yellow('🚀 Continuing without funding.'));
                }
            } else {
                console.log(chalk.green(`✅ Server balance is sufficient: ${balance} satoshis.`));
            }
        } else if (action === 'save') {
            // Save config and exit
            fs.writeFileSync(LARS_CONFIG_PATH, JSON.stringify(config, null, 2));
            console.log(chalk.green('✅ LARS config saved.'));
            done = true;
        }
    }
}

program
    .command('config')
    .description('Edit LARS configuration')
    .action(async () => {
        await editConfig();
    });

program
    .command('start')
    .description('Start LARS development environment')
    .action(async () => {
        const { default: chalk } = await import('chalk');
        const { default: inquirer } = await import('inquirer');

        try {
            console.log(
                chalk.yellow(
                    figlet.textSync('LARS', { horizontalLayout: 'full' })
                )
            );
            console.log(chalk.green('Welcome to the LARS development environment! 🚀'));
            console.log(chalk.green("Let's get your local Overlay Services up and running!\n"));

            // Load config (or create if not present)
            const config = await loadOrCreateConfig();

            // Step 1: Parse and validate deployment-info.json
            if (!fs.existsSync(DEPLOYMENT_INFO_PATH)) {
                console.error(chalk.red('❌ deployment-info.json not found in the current directory.'));
                process.exit(1);
            }
            const deploymentInfo = JSON.parse(fs.readFileSync(DEPLOYMENT_INFO_PATH, 'utf-8'));

            // Step 2: Check for system dependencies
            console.log(chalk.blue('🔍 Checking system dependencies...'));
            // Check Docker
            try {
                execSync('docker --version', { stdio: 'ignore' });
            } catch (err) {
                console.error(chalk.red('❌ Docker is not installed or not running.'));
                console.log(chalk.blue('👉 Install Docker: https://docs.docker.com/engine/install/'));
                process.exit(1);
            }
            // Check Docker Compose
            try {
                execSync('docker compose version', { stdio: 'ignore' });
            } catch (err) {
                console.error(chalk.red('❌ Docker Compose plugin is not installed.'));
                console.log(chalk.blue('👉 Install Docker Compose: https://docs.docker.com/compose/install/'));
                process.exit(1);
            }
            // Check ngrok
            try {
                execSync('ngrok version', { stdio: 'ignore' });
            } catch (err) {
                console.error(chalk.red('❌ ngrok is not installed.'));
                console.log(chalk.blue('👉 Install ngrok: https://ngrok.com/download'));
                process.exit(1);
            }

            // Check MetaNet Client
            try {
                await getVersion();
            } catch (err) {
                console.error(chalk.red('❌ MetaNet Client is not installed or not running.'));
                console.log(chalk.blue('👉 Download MetaNet Client: https://projectbabbage.com/'));
                process.exit(1);
            }

            // Check write access to ./local-data
            try {
                fs.ensureDirSync(LOCAL_DATA_PATH);
            } catch (err) {
                console.error(chalk.red('❌ Cannot write to ./local-data directory.'));
                process.exit(1);
            }

            // Step 3: Start ngrok and get public URL
            console.log(chalk.blue('🌐 Starting ngrok...'));
            const ngrokUrl = await ngrok.connect({ addr: 8080 });
            console.log(chalk.green(`🚀 ngrok tunnel established at ${ngrokUrl}`));

            // Generate a ninja and check balance
            const ninja = new Ninja({ privateKey: config.serverPrivateKey });
            const { total: balance } = await ninja.getTotalValue();
            if (balance < 10000) {
                console.log(chalk.red(`⚠️  Your server's balance is low: ${balance} satoshis.`));
                const { action } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'action',
                        message: 'Your server\'s balance is low. What would you like to do?',
                        choices: [
                            '💰 Fund server automatically (using local MetaNet Client)',
                            '📝 Print manual funding instructions',
                            '🚀 Continue without funding',
                        ],
                    },
                ]);

                if (action === '💰 Fund server automatically (using local MetaNet Client)') {
                    const { amountToFund } = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'amountToFund',
                            message: 'Enter the amount to fund (in satoshis):',
                            default: '30000',
                            validate: function (value) {
                                const valid = !isNaN(parseInt(value)) && parseInt(value) > 0;
                                return valid || 'Please enter a positive number.';
                            },
                            filter: Number,
                        },
                    ]);
                    await fundNinja(ninja, amountToFund, config.serverPrivateKey);
                    console.log(chalk.green(`🎉 Server funded with ${amountToFund} satoshis.`));
                } else if (action === '📝 Print manual funding instructions') {
                    console.log(chalk.blue('\nManual Funding Instructions:'));
                    console.log('1. Use KeyFunder to fund your server.');
                    console.log(`2. Your server's Ninja private key is: ${config.serverPrivateKey}`);
                    console.log('3. Visit https://keyfunder.babbage.systems and follow the instructions.');
                    await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'wait',
                            message: 'Press enter when you\'re ready to continue.',
                        },
                    ]);
                } else {
                    console.log(chalk.yellow('🚀 Continuing without funding.'));
                }
            } else {
                console.log(chalk.green(`✅ Server balance is sufficient: ${balance} satoshis.`));
            }

            // Determine whether sCrypt contracts are enabled
            let enableContracts = false
            if (deploymentInfo.contracts && Object.keys(deploymentInfo.contracts) > 0) {
                if (deploymentInfo.contracts.language === 'sCrypt') {
                    enableContracts = true
                } else {
                    console.error(chalk.red(`❌ BSV Contract language not supported: ${deploymentInfo.contracts.language}`));
                    process.exit(1);
                }
            }

            // Step 4: Generate docker-compose.yml
            console.log(chalk.blue('\n📝 Generating docker-compose.yml...'));
            const composeContent = generateDockerCompose(ngrokUrl, LOCAL_DATA_PATH, config.serverPrivateKey, enableContracts);
            const composeYaml = yaml.stringify(composeContent);
            const composeFilePath = path.join(LOCAL_DATA_PATH, 'docker-compose.yml');
            fs.writeFileSync(composeFilePath, composeYaml);
            console.log(chalk.green('✅ docker-compose.yml generated.'));

            // Step 5: Generate overlay-dev-container files
            console.log(chalk.blue('\n📁 Generating overlay-dev-container files...'));
            const overlayDevContainerPath = path.join(LOCAL_DATA_PATH, 'overlay-dev-container');
            fs.ensureDirSync(overlayDevContainerPath);

            // Generate index.ts
            const indexTsContent = generateIndexTs(deploymentInfo, config);
            fs.writeFileSync(path.join(overlayDevContainerPath, 'index.ts'), indexTsContent);

            // Generate package.json
            const backendPackageJsonPath = path.resolve(process.cwd(), 'backend', 'package.json');
            let backendDependencies = {};
            if (fs.existsSync(backendPackageJsonPath)) {
                const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, 'utf-8'));
                backendDependencies = backendPackageJson.dependencies || {};
            } else {
                console.warn(chalk.yellow('⚠️  No backend/package.json found.'));
            }
            const packageJsonContent = generatePackageJson(backendDependencies);
            fs.writeFileSync(path.join(overlayDevContainerPath, 'package.json'), JSON.stringify(packageJsonContent, null, 2));

            // Generate tsconfig.json
            const tsconfigContent = generateTsConfig();
            fs.writeFileSync(path.join(overlayDevContainerPath, 'tsconfig.json'), tsconfigContent);

            // Generate wait script
            fs.writeFileSync(path.join(overlayDevContainerPath, 'wait-for-services.sh'), generateWaitScript());

            // Generate Dockerfile
            const dockerfileContent = generateDockerfile(enableContracts);
            fs.writeFileSync(path.join(overlayDevContainerPath, 'Dockerfile'), dockerfileContent);

            console.log(chalk.green('✅ overlay-dev-container files generated.'));

            // Step 6: Start Docker Compose
            console.log(chalk.blue('\n🐳 Starting Docker Compose...'));
            const dockerComposeUp = spawn('docker', ['compose', 'up', '--build'], {
                cwd: LOCAL_DATA_PATH,
                stdio: 'inherit'
            });

            dockerComposeUp.on('exit', (code) => {
                if (code === 0) {
                    console.log(chalk.green(`🐳 Docker Compose is going down.`));
                } else {
                    console.log(chalk.red(`❌ Docker Compose exited with code ${code}`));
                }
                console.log(chalk.blue(`👋 LARS will see you next time!`));
                process.exit(0);
            });

            // Step 7: Set up file watchers
            console.log(chalk.blue('\n👀 Setting up file watchers...'));
            const backendSrcPath = path.resolve(process.cwd(), 'backend', 'src');

            const watcher = chokidar.watch(backendSrcPath, { ignoreInitial: true });

            watcher.on('all', (event, filePath) => {
                console.log(chalk.yellow(`🔄 File ${event}: ${filePath}`));

                if (filePath.startsWith(path.join(backendSrcPath, 'contracts')) && enableContracts) {
                    // Run npm run compile in backend
                    console.log(chalk.blue('🔨 Changes detected in contracts directory. Running npm run compile...'));
                    const compileProcess = spawn('npm', ['run', 'compile'], {
                        cwd: path.resolve(process.cwd(), 'backend'),
                        stdio: 'inherit'
                    });

                    compileProcess.on('exit', (code) => {
                        if (code === 0) {
                            console.log(chalk.green('✅ Contract compilation completed.'));
                        } else {
                            console.error(chalk.red(`❌ Contract compilation failed with exit code ${code}.`));
                        }
                    });
                }
            });

            console.log(chalk.green('\n🎉 LARS development environment is up and running! Happy coding!'));

        } catch (err) {
            const { default: chalk } = await import('chalk');
            console.error(chalk.red('❌ Error starting LARS:', err));
            process.exit(0);
        }
    });

program.parse(process.argv);

// Helper functions
function generateDockerCompose(hostingUrl, localDataPath, serverPrivateKey, enableContracts) {
    const composeContent = {
        services: {
            'overlay-dev-container': {
                build: {
                    context: '..',
                    dockerfile: './local-data/overlay-dev-container/Dockerfile'
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
                    `${path.resolve(process.cwd(), 'backend', 'src')}:/app/src`
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
                image: 'mongo:6.0',
                container_name: 'overlay-mongo',
                ports: [
                    '27017:27017'
                ],
                volumes: [
                    `${path.resolve(localDataPath, 'mongo')}:/data/db`
                ],
                command: ["mongod", "--quiet"] // reduces verbosity of Mongo logs
            }
        }
    };
    if (enableContracts) {
        composeContent.services['overlay-dev-container'].volumes.push(`${path.resolve(process.cwd(), 'backend', 'artifacts')}:/app/artifacts`)
    }
    return composeContent;
}

function generateIndexTs(deploymentInfo, config) {
    let imports = `
import OverlayExpress from '@bsv/overlay-express'
`;
    let mainFunction = `
const main = async () => {

    const server = new OverlayExpress(
        \`LARS\`,
        process.env.SERVER_PRIVATE_KEY!,
        process.env.HOSTING_URL!
    )

    server.configurePort(8080)
    server.configureVerboseRequestLogging(${config.enableRequestLogging})
    await server.configureKnex(process.env.KNEX_URL!)
    await server.configureMongo(process.env.MONGO_URL!)
    server.configureEnableGASPSync(${config.enableGASPSync})
`;

    if (config.arcApiKey) {
        mainFunction += `    server.configureArcApiKey("${config.arcApiKey}")\n`;
    }

    // For each topic manager
    for (const [name, pathToTm] of Object.entries(deploymentInfo.topicManagers || {})) {
        const importName = `tm_${name}`;
        const pathToTmInContainer = path.join('/app', path.relative(process.cwd(), pathToTm)).replace(/\\/g, '/').replace('/backend/', '/');
        imports += `import ${importName} from '${pathToTmInContainer}'\n`;
        mainFunction += `    server.configureTopicManager('${name}', new ${importName}())\n`;
    }

    // For each lookup service
    for (const [name, lsConfig] of Object.entries(deploymentInfo.lookupServices || {})) {
        const importName = `lsf_${name}`;
        const pathToLsInContainer = path.join('/app', path.relative(process.cwd(), lsConfig.serviceFactory)).replace(/\\/g, '/').replace('/backend/', '/');
        imports += `import ${importName} from '${pathToLsInContainer}'\n`;
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

main()`;

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
            ...backendDependencies,
            "@bsv/overlay-express": "^0.1.9",
            "mysql2": "^3.11.5",
            "tsx": "^4.19.2"
        },
        "devDependencies": {
            "@types/node": "^22.10.1"
        }
    };
    return packageJsonContent;
}

function generateDockerfile(enableContracts) {
    let file = `FROM node:22-alpine
WORKDIR /app
COPY ./local-data/overlay-dev-container/package.json .
RUN npm i
COPY ./local-data/overlay-dev-container/index.ts .
COPY ./local-data/overlay-dev-container/tsconfig.json .
COPY ./local-data/overlay-dev-container/wait-for-services.sh /wait-for-services.sh
RUN chmod +x /wait-for-services.sh`
    if (enableContracts) {
        file += `
COPY ./backend/artifacts ./artifacts`
    }
    file += `
COPY ./backend/src ./src

# Expose the application port
EXPOSE 8080

# Start the application
CMD ["/wait-for-services.sh", "mysql", "3306", "mongo", "27017", "npm", "run", "start"]`;
    return file;
}

function generateTsConfig() {
    return `{
    "compilerOptions": {
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true
    }
}`;
}

function generateWaitScript() {
    return `#!/bin/sh

set -e

host1="$1"
port1="$2"
host2="$3"
port2="$4"
shift 4

echo "Waiting for $host1:$port1..."
while ! nc -z $host1 $port1; do
  sleep 1
done
echo "$host1:$port1 is up"

echo "Waiting for $host2:$port2..."
while ! nc -z $host2 $port2; do
  sleep 1
done
echo "$host2:$port2 is up"

exec "$@"`
}

const fundNinja = async (ninja, amount, ninjaPriv) => {
    const derivationPrefix = crypto.randomBytes(10)
        .toString('base64')
    const derivationSuffix = crypto.randomBytes(10)
        .toString('base64')
    const derivedPublicKey = await getPublicKey({
        counterparty: new PrivateKey(ninjaPriv, 'hex').toPublicKey().toString(),
        protocolID: '3241645161d8',
        keyID: `${derivationPrefix} ${derivationSuffix}`
    })
    const script = new P2PKH().lock(PublicKey.fromString(derivedPublicKey).toAddress()).toHex()
    const outputs = [{
        script,
        satoshis: amount
    }]
    const transaction = await createAction({
        outputs,
        description: 'Funding Local Overlay Services host for development'
    })
    transaction.outputs = [{
        vout: 0,
        satoshis: amount,
        derivationSuffix
    }]
    const directTransaction = {
        derivationPrefix,
        transaction,
        senderIdentityKey: await getPublicKey({ identityKey: true }),
        protocol: '3241645161d8',
        note: 'Incoming payment from KeyFunder'
    }
    await ninja.submitDirectTransaction(directTransaction)
    console.log('ninja funded!')
}