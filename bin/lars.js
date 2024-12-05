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

            // Step 1: Parse and validate deployment-info.json
            const deploymentInfoPath = path.resolve(process.cwd(), 'deployment-info.json');
            if (!fs.existsSync(deploymentInfoPath)) {
                console.error(chalk.red('❌ deployment-info.json not found in the current directory.'));
                process.exit(1);
            }
            const deploymentInfo = JSON.parse(fs.readFileSync(deploymentInfoPath, 'utf-8'));

            // Step 2: Check for system dependencies
            console.log(chalk.blue('🔍 Checking system dependencies...'));
            // Check Docker
            try {
                execSync('docker --version', { stdio: 'ignore' });
            } catch (err) {
                console.error(chalk.red('❌ Docker is not installed or not running.'));
                process.exit(1);
            }
            // Check Docker Compose
            try {
                execSync('docker compose version', { stdio: 'ignore' });
            } catch (err) {
                console.error(chalk.red('❌ Docker Compose plugin is not installed.'));
                process.exit(1);
            }
            // Check ngrok
            try {
                execSync('ngrok version', { stdio: 'ignore' });
            } catch (err) {
                console.error(chalk.red('❌ ngrok is not installed.'));
                process.exit(1);
            }

            // Check MetaNet Client
            try {
                await getVersion()
            } catch (err) {
                console.error(chalk.red('❌ MetaNet Client is not installed. Launch the app or download from https://projectbabbage.com.'));
                process.exit(1);
            }

            // Check write access to ./local-data
            const localDataPath = path.resolve(process.cwd(), 'local-data');
            try {
                fs.ensureDirSync(localDataPath);
            } catch (err) {
                console.error(chalk.red('❌ Cannot write to ./local-data directory.'));
                process.exit(1);
            }

            // Step 3: Start ngrok and get public URL
            console.log(chalk.blue('🌐 Starting ngrok...'));
            const ngrokUrl = await ngrok.connect({ addr: 8080 });
            console.log(chalk.green(`🚀 ngrok tunnel established at ${ngrokUrl}`));

            // Save HOSTING_URL for later use
            const hostingUrl = ngrokUrl;

            // Generate a server private key
            let serverPrivateKeyPath = path.resolve(localDataPath, 'server-private-key.txt');
            let serverPrivateKey;

            if (fs.existsSync(serverPrivateKeyPath)) {
                serverPrivateKey = fs.readFileSync(serverPrivateKeyPath, 'utf-8').trim();
                // Validate 64-character lowercase hex string
                if (!/^[0-9a-f]{64}$/.test(serverPrivateKey)) {
                    console.error(chalk.red('❌ Invalid private key format in server-private-key.txt'));
                    process.exit(1);
                }
            } else {
                console.log(chalk.yellow('⚠️  No server private key found.'));
                const { action } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'action',
                        message: 'Do you want to generate a new private key or enter an existing one?',
                        choices: ['🔑 Generate new key', '✏️ Enter existing key'],
                    },
                ]);

                if (action === '🔑 Generate new key') {
                    serverPrivateKey = crypto.randomBytes(32).toString('hex');
                    fs.writeFileSync(serverPrivateKeyPath, serverPrivateKey);
                    console.log(chalk.green('✨ New private key generated and saved to server-private-key.txt'));
                } else {
                    const { enteredKey } = await inquirer.prompt([
                        {
                            type: 'password',
                            name: 'enteredKey',
                            message: 'Enter your private key (hex format):',
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
                    fs.writeFileSync(serverPrivateKeyPath, serverPrivateKey);
                    console.log(chalk.green('🔐 Private key saved to server-private-key.txt'));
                }
            }

            // Check balance and fund if necessary
            const ninja = new Ninja({
                privateKey: serverPrivateKey
            });
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
                    await fundNinja(ninja, amountToFund, serverPrivateKey);
                    console.log(chalk.green(`🎉 Server funded with ${amountToFund} satoshis.`));
                } else if (action === '📝 Print manual funding instructions') {
                    console.log(chalk.blue('\nManual Funding Instructions:'));
                    console.log('1. Use KeyFunder to fund your server.');
                    console.log(`2. Your server's Ninja private key is: ${serverPrivateKey}`);
                    console.log('3. Visit https://keyfunder.babbage.systems and follow the instructions.');
                    await inquirer.prompt([ // TODO: Use the correct "wait" prompt.
                        {
                            type: 'input',
                            name: 'amountToFund',
                            message: 'Press enter when you\'re ready to continue.',
                        },
                    ]);
                } else {
                    console.log(chalk.yellow('🚀 Continuing without funding.'));
                }
            } else {
                console.log(chalk.green(`✅ Server balance is sufficient: ${balance} satoshis.`));
            }

            // Step 4: Generate docker-compose.yml
            console.log(chalk.blue('\n📝 Generating docker-compose.yml...'));
            const composeContent = generateDockerCompose(hostingUrl, localDataPath, serverPrivateKey);
            const composeYaml = yaml.stringify(composeContent);
            const composeFilePath = path.join(localDataPath, 'docker-compose.yml');
            fs.writeFileSync(composeFilePath, composeYaml);
            console.log(chalk.green('✅ docker-compose.yml generated.'));

            // Step 5: Generate index.ts, package.json, Dockerfile
            console.log(chalk.blue('\n📁 Generating overlay-dev-container files...'));
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
            const dockerfileContent = generateDockerfile();
            fs.writeFileSync(path.join(overlayDevContainerPath, 'Dockerfile'), dockerfileContent);

            console.log(chalk.green('✅ overlay-dev-container files generated.'));

            // Step 6: Start Docker Compose
            console.log(chalk.blue('\n🐳 Starting Docker Compose...'));
            const dockerComposeUp = spawn('docker', ['compose', 'up', '--build'], {
                cwd: localDataPath,
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

                if (filePath.startsWith(path.join(backendSrcPath, 'contracts'))) {
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
            console.error(chalk.red('❌ Error starting LARS:', err));
            process.exit(0);
        }
    });

program.parse(process.argv);

// Helper functions
function generateDockerCompose(hostingUrl, localDataPath, serverPrivateKey) {
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
                    HOSTING_URL: hostingUrl,
                },
                depends_on: [
                    'mysql',
                    'mongo'
                ],
                volumes: [
                    `${path.resolve(process.cwd(), 'backend', 'src')}:/app/src`,
                    `${path.resolve(process.cwd(), 'backend', 'artifacts')}:/app/artifacts`
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
                ]
            }
        }
    };
    return composeContent;
}

function generateIndexTs(deploymentInfo) {
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
    server.configureVerboseRequestLogging(true)
    await server.configureKnex(process.env.KNEX_URL!)
    await server.configureMongo(process.env.MONGO_URL!)
    server.configureEnableGASPSync(false)
`;

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
            "@bsv/overlay-express": "^0.1.7",
            "mysql2": "^3.11.5",
            "tsx": "^4.19.2"
        },
        "devDependencies": {
            "@types/node": "^22.10.1"
        }
    };
    return packageJsonContent;
}

function generateDockerfile() {
    return `FROM node:22-alpine
WORKDIR /app
COPY ./local-data/overlay-dev-container/package.json .
RUN npm i
COPY ./local-data/overlay-dev-container/index.ts .
COPY ./local-data/overlay-dev-container/tsconfig.json .
COPY ./local-data/overlay-dev-container/wait-for-services.sh /wait-for-services.sh
RUN chmod +x /wait-for-services.sh
COPY ./backend/artifacts ./artifacts
COPY ./backend/src ./src

# Expose the application port
EXPOSE 8080

# Start the application
CMD ["/wait-for-services.sh", "mysql", "3306", "mongo", "27017", "npm", "run", "start"]`;
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