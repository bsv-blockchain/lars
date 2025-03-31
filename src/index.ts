#!/usr/bin/env node
import { program } from 'commander'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import chalk from 'chalk'
import inquirer from 'inquirer'
import figlet from 'figlet'
import { spawn, execSync, ChildProcess } from 'child_process'
import chokidar from 'chokidar'
import yaml from 'yaml'
import crypto from 'crypto'
import ngrok from 'ngrok'
import axios from 'axios'
import { InternalizeActionArgs, KeyDeriver, P2PKH, PrivateKey, PublicKey, WalletClient, WalletInterface } from '@bsv/sdk'
import { Services, StorageClient, Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-client'
import open from 'open'

/// //////////////////////////////////////////////////////////////////////////////////
// Constants and Types
/// //////////////////////////////////////////////////////////////////////////////////

interface CARSConfig {
    name: string
    network?: string
    provider: string
    projectID?: string
    CARSCloudURL?: string
    deploy?: string[]
    frontendHostingMethod?: string
    authentication?: any
    payments?: any
    run?: string[] // For LARS only - which services to run e.g. ['backend'] or ['frontend'] or ['backend', 'frontend']
}

interface CARSConfigInfo {
    schema: string
    schemaVersion: string
    topicManagers?: Record<string, string>
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>
    frontend?: { language: string; sourceDirectory: string }
    contracts?: { language: string; baseDirectory: string }
    configs?: CARSConfig[]
}

interface NetworkKeys {
    serverPrivateKey?: string
    arcApiKey?: string
}

interface ProjectKeys {
    mainnet: NetworkKeys
    testnet: NetworkKeys
}

// Advanced engine config interface on top of your existing local config
interface OverlayAdvancedConfig {
    adminToken?: string // Bearer token for admin routes
    syncConfiguration?: Record<string, false | string[] | 'SHIP'>
    logTime?: boolean
    logPrefix?: string
    throwOnBroadcastFailure?: boolean
}

// We store advanced engine config in the local project config
interface LARSConfigLocal {
    projectKeys: ProjectKeys
    enableRequestLogging: boolean
    enableGASPSync: boolean
    // Overlay advanced config for customizing OverlayExpress
    overlayAdvancedConfig?: OverlayAdvancedConfig
}

interface GlobalKeys {
    mainnet?: {
        serverPrivateKey?: string
        taalApiKey?: string
    }
    testnet?: {
        serverPrivateKey?: string
        taalApiKey?: string
    }
}

/// //////////////////////////////////////////////////////////////////////////////////
// File paths
/// //////////////////////////////////////////////////////////////////////////////////

const PROJECT_ROOT = process.cwd()
const DEPLOYMENT_INFO_PATH = path.join(PROJECT_ROOT, 'deployment-info.json')
const LOCAL_DATA_PATH = path.resolve(PROJECT_ROOT, 'local-data')
const LARS_CONFIG_PATH = path.join(LOCAL_DATA_PATH, 'lars-config.json')
const GLOBAL_KEYS_PATH = path.join(os.homedir(), '.lars-keys.json')

/// //////////////////////////////////////////////////////////////////////////////////
// Default LARS config
/// //////////////////////////////////////////////////////////////////////////////////

function getDefaultProjectConfig(): LARSConfigLocal {
    return {
        projectKeys: {
            mainnet: { serverPrivateKey: undefined, arcApiKey: undefined },
            testnet: { serverPrivateKey: undefined, arcApiKey: undefined }
        },
        enableRequestLogging: true,
        enableGASPSync: false,
        overlayAdvancedConfig: {
            adminToken: undefined,
            syncConfiguration: {},
            logTime: false,
            logPrefix: '[LARS OVERLAY ENGINE] ',
            throwOnBroadcastFailure: false
        }
    }
}

/// //////////////////////////////////////////////////////////////////////////////////
// Utility functions
/// //////////////////////////////////////////////////////////////////////////////////

function loadDeploymentInfo(): CARSConfigInfo {
    if (!fs.existsSync(DEPLOYMENT_INFO_PATH)) {
        console.error(chalk.red('❌ deployment-info.json not found in the current directory.'))
        process.exit(1)
    }
    const info = JSON.parse(fs.readFileSync(DEPLOYMENT_INFO_PATH, 'utf-8'))
    info.configs = info.configs || []
    return info
}

function getLARSConfigFromDeploymentInfo(info: CARSConfigInfo): CARSConfig | undefined {
    // Find the LARS config (provider === 'LARS')
    return info.configs?.find(c => c.provider === 'LARS')
}

function ensureLocalDataDir() {
    fs.ensureDirSync(LOCAL_DATA_PATH)
}

function loadOrInitGlobalKeys(): GlobalKeys {
    let keys: GlobalKeys = {}
    if (fs.existsSync(GLOBAL_KEYS_PATH)) {
        keys = JSON.parse(fs.readFileSync(GLOBAL_KEYS_PATH, 'utf-8'))
    }
    keys.mainnet = keys.mainnet || {}
    keys.testnet = keys.testnet || {}
    return keys
}

function saveGlobalKeys(keys: GlobalKeys) {
    fs.writeFileSync(GLOBAL_KEYS_PATH, JSON.stringify(keys, null, 2))
}

function loadProjectConfig(): LARSConfigLocal {
    if (!fs.existsSync(LARS_CONFIG_PATH)) {
        return getDefaultProjectConfig()
    }
    const existingConfig = JSON.parse(fs.readFileSync(LARS_CONFIG_PATH, 'utf-8'))
    return { ...getDefaultProjectConfig(), ...existingConfig }
}

function saveProjectConfig(config: LARSConfigLocal) {
    ensureLocalDataDir()
    fs.writeFileSync(LARS_CONFIG_PATH, JSON.stringify(config, null, 2))
}

async function promptForPrivateKey(): Promise<string> {
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Do you want to generate a new server private key or enter an existing one?',
            choices: [
                { name: '🔑 Generate new key', value: 'generate' },
                { name: '✏️ Enter existing key', value: 'enter' }
            ]
        }
    ])

    if (action === 'generate') {
        const key = crypto.randomBytes(32).toString('hex')
        console.log(chalk.green('✨ New private key generated.'))
        return key
    } else {
        const { enteredKey } = await inquirer.prompt([
            {
                type: 'password',
                name: 'enteredKey',
                message: 'Enter your server private key (64-char hex):',
                mask: '*',
                validate: function (value: string) {
                    if (/^[0-9a-fA-F]{64}$/.test(value)) {
                        return true
                    }
                    return 'Please enter a valid 64-character hexadecimal string.'
                }
            }
        ])
        const key = enteredKey.toLowerCase()
        console.log(chalk.green('🔐 Server private key set.'))
        return key
    }
}

async function promptForArcApiKey(): Promise<string | undefined> {
    const { setArcKey } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'setArcKey',
            message: 'Do you have a TAAL (ARC) API key to set? (You can get one from https://taal.com/) (optional)',
            default: false
        }
    ])

    if (!setArcKey) {
        return undefined
    }

    const { enteredArcKey } = await inquirer.prompt([
        {
            type: 'input',
            name: 'enteredArcKey',
            message: 'Enter your TAAL (ARC) API key:'
        }
    ])

    const arcApiKey = enteredArcKey.trim()
    console.log(chalk.green('🔑 TAAL (ARC) API key set.'))
    return arcApiKey
}

async function promptYesNo(message: string, defaultVal = true): Promise<boolean> {
    const { answer } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'answer',
            message,
            default: defaultVal
        }
    ])
    return answer
}

async function makeWallet(chain: 'test' | 'main', privateKey: string): Promise<WalletInterface> {
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'))
    const storageManager = new WalletStorageManager(keyDeriver.identityKey)
    const signer = new WalletSigner(chain, keyDeriver, storageManager)
    const services = new Services(chain)
    const wallet = new Wallet(signer, services)
    const client = new StorageClient(
        wallet,
        // Hard-code storage URLs for now, but this should be configurable in the future along with the private key.
        chain === 'test' ? 'https://staging-storage.babbage.systems' : 'https://storage.babbage.systems'
    )
    await client.makeAvailable()
    await storageManager.addWalletStorageProvider(client)
    return wallet
}

async function fundWallet(wallet: WalletInterface, amount: number, walletPrivateKey: string, network: 'mainnet' | 'testnet') {
    const localWallet = new WalletClient('auto', 'localhost')
    try {
        const { version } = await localWallet.getVersion()
        console.log(chalk.blue(`💰 Using local wallet version: ${version}`))
    } catch (err) {
        console.error(chalk.red('❌ MetaNet Client is not installed or not running.'))
        console.log(chalk.blue('👉 Download MetaNet Client: https://projectbabbage.com/'))
        process.exit(1)
    }
    const { network: localNet } = await localWallet.getNetwork()
    if (network !== localNet) {
        console.warn(
            chalk.red(
                `The currently-running MetaNet Client is on ${localNet} but LARS is configured for ${network}. Funding from local wallet is impossible.`
            )
        )
        return
    }
    const derivationPrefix = crypto.randomBytes(10).toString('base64')
    const derivationSuffix = crypto.randomBytes(10).toString('base64')
    const { publicKey: payer } = await localWallet.getPublicKey({ identityKey: true })
    const payee = new PrivateKey(walletPrivateKey, 'hex').toPublicKey().toString()
    const { publicKey: derivedPublicKey } = await localWallet.getPublicKey({
        counterparty: payee,
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`
    })
    const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(derivedPublicKey).toAddress())
        .toHex()
    const outputs = [
        {
            lockingScript,
            customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee }),
            satoshis: amount,
            outputDescription: 'Fund LARS for local dev'
        }
    ]
    const transaction = await localWallet.createAction({
        outputs,
        description: 'Funding LARS for development',
        options: {
            randomizeOutputs: false
        }
    })
    const directTransaction: InternalizeActionArgs = {
        tx: transaction.tx,
        outputs: [
            {
                outputIndex: 0,
                protocol: 'wallet payment',
                paymentRemittance: {
                    derivationPrefix,
                    derivationSuffix,
                    senderIdentityKey: payer
                }
            }
        ],
        description: 'Incoming LARS funding payment from local wallet'
    }
    await wallet.internalizeAction(directTransaction)
    console.log(chalk.green('🎉 LARS Wallet funded!'))
}

function getCurrentNetwork(larsConfig: CARSConfig): 'mainnet' | 'testnet' {
    return larsConfig.network === 'mainnet' ? 'mainnet' : 'testnet'
}

/// //////////////////////////////////////////////////////////////////////////////////
// Menus for editing config and keys
/// //////////////////////////////////////////////////////////////////////////////////

async function maybeHoistProjectKeyToGlobal(
    projectVal: string | undefined,
    globalVal: string | undefined,
    setter: (val: string) => void,
    keyType: 'serverPrivateKey' | 'taalApiKey',
    network: 'mainnet' | 'testnet'
) {
    if (projectVal && !globalVal) {
        const ask = await promptYesNo(
            `Would you like to also save this ${keyType === 'serverPrivateKey' ? 'server key' : 'TAAL API key'
            } to your global keys for ${network}?`
        )
        if (ask) {
            const globalKeys = loadOrInitGlobalKeys()
            if (keyType === 'serverPrivateKey') {
                globalKeys[network]!.serverPrivateKey = projectVal
            } else {
                globalKeys[network]!.taalApiKey = projectVal
            }
            saveGlobalKeys(globalKeys)
            console.log(chalk.green('✅ Key saved globally.'))
        }
    }
}

// Edit local project config interactively (keys and toggles)
async function editLocalConfig(projectConfig: LARSConfigLocal, network: 'mainnet' | 'testnet') {
    const globalKeys = loadOrInitGlobalKeys()
    const netKeys = projectConfig.projectKeys[network]
    const effectiveServerKey = netKeys.serverPrivateKey || globalKeys[network]?.serverPrivateKey
    const effectiveArcApiKey = netKeys.arcApiKey || globalKeys[network]?.taalApiKey

    let done = false
    while (!done) {
        console.log(chalk.blue(`\nProject config menu (Network: ${network})`))
        const choices = [
            {
                name: `Server private key: ${effectiveServerKey ? '(set)' : '(not set)'
                    } (project-level: ${netKeys.serverPrivateKey ? 'yes' : 'no'})`,
                value: 'serverKey'
            },
            {
                name: `TAAL (ARC) API key: ${effectiveArcApiKey ? '(set)' : '(not set)'
                    } (project-level: ${netKeys.arcApiKey ? 'yes' : 'no'})`,
                value: 'arcKey'
            },
            {
                name: `Request logging: ${projectConfig.enableRequestLogging ? 'enabled' : 'disabled'}`,
                value: 'reqlog'
            },
            {
                name: `GASP sync: ${projectConfig.enableGASPSync ? 'enabled' : 'disabled'}`,
                value: 'gasp'
            },
            {
                name: 'Advanced Overlay Engine Config',
                value: 'advancedEngine'
            },
            { name: 'Done', value: 'done' }
        ]

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Select an action:',
                choices
            }
        ])

        if (action === 'serverKey') {
            const { keyAction } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'keyAction',
                    message: 'Manage server private key:',
                    choices: [
                        { name: 'Set project-level key', value: 'set' },
                        { name: 'Use global key', value: 'useGlobal' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ])
            if (keyAction === 'set') {
                const newKey = await promptForPrivateKey()
                netKeys.serverPrivateKey = newKey
                saveProjectConfig(projectConfig)
                await maybeHoistProjectKeyToGlobal(
                    newKey,
                    globalKeys[network]?.serverPrivateKey,
                    val => {
                        globalKeys[network]!.serverPrivateKey = val
                        saveGlobalKeys(globalKeys)
                    },
                    'serverPrivateKey',
                    network
                )
            } else if (keyAction === 'useGlobal') {
                netKeys.serverPrivateKey = undefined
                saveProjectConfig(projectConfig)
            }
        } else if (action === 'arcKey') {
            const { keyAction } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'keyAction',
                    message: 'Manage TAAL (ARC) API key:',
                    choices: [
                        { name: 'Set project-level key', value: 'set' },
                        { name: 'Use global key', value: 'useGlobal' },
                        { name: 'Unset project-level key', value: 'unset' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ])
            if (keyAction === 'set') {
                const newArc = await promptForArcApiKey()
                if (newArc) {
                    netKeys.arcApiKey = newArc
                    saveProjectConfig(projectConfig)
                    await maybeHoistProjectKeyToGlobal(
                        newArc,
                        globalKeys[network]?.taalApiKey,
                        val => {
                            globalKeys[network]!.taalApiKey = val
                            saveGlobalKeys(globalKeys)
                        },
                        'taalApiKey',
                        network
                    )
                }
            } else if (keyAction === 'useGlobal') {
                netKeys.arcApiKey = undefined
                saveProjectConfig(projectConfig)
            } else if (keyAction === 'unset') {
                netKeys.arcApiKey = undefined
                saveProjectConfig(projectConfig)
            }
        } else if (action === 'reqlog') {
            projectConfig.enableRequestLogging = !projectConfig.enableRequestLogging
            saveProjectConfig(projectConfig)
        } else if (action === 'gasp') {
            projectConfig.enableGASPSync = !projectConfig.enableGASPSync
            saveProjectConfig(projectConfig)

            // If they turned off GASP globally, also override advanced sync config if desired
            if (!projectConfig.enableGASPSync && projectConfig.overlayAdvancedConfig?.syncConfiguration) {
                const disableAll = await promptYesNo(
                    'You turned off GASP sync. Would you like to set all topics in syncConfiguration to false?',
                    false
                )
                if (disableAll) {
                    const newSyncConfig: Record<string, false> = {}
                    Object.keys(projectConfig.overlayAdvancedConfig.syncConfiguration).forEach(topic => {
                        newSyncConfig[topic] = false
                    })
                    projectConfig.overlayAdvancedConfig.syncConfiguration = newSyncConfig
                    saveProjectConfig(projectConfig)
                    console.log(chalk.green('✅ All topics in syncConfiguration set to false.'))
                }
            }
        } else if (action === 'advancedEngine') {
            await editOverlayAdvancedConfig(projectConfig)
        } else {
            done = true
        }
    }
}

// A separate function to handle editing advanced overlay engine config
async function editOverlayAdvancedConfig(projectConfig: LARSConfigLocal) {
    projectConfig.overlayAdvancedConfig = projectConfig.overlayAdvancedConfig || {}
    let done = false
    while (!done) {
        console.log(chalk.blue('\nAdvanced Overlay Engine Config Menu'))
        const cfg = projectConfig.overlayAdvancedConfig
        const choices = [
            {
                name: `Bearer Token (adminToken): ${cfg.adminToken ? '(set)' : '(not set, will auto-generate)'
                    } `,
                value: 'adminToken'
            },
            {
                name: `logTime: ${cfg.logTime ? 'true' : 'false'}`,
                value: 'logTime'
            },
            {
                name: `logPrefix: ${cfg.logPrefix || '[LARS OVERLAY ENGINE] '}`,
                value: 'logPrefix'
            },
            {
                name: `throwOnBroadcastFailure: ${cfg.throwOnBroadcastFailure ? 'true' : 'false'}`,
                value: 'throwFail'
            },
            {
                name: `syncConfiguration: ${JSON.stringify(cfg.syncConfiguration || {})}`,
                value: 'syncConfig'
            },
            { name: 'Done', value: 'done' }
        ]

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Select an advanced config to edit:',
                choices
            }
        ])

        if (action === 'adminToken') {
            const { setToken } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'setToken',
                    message:
                        "Do you want to set a custom Bearer token? If 'No', it will be auto-generated at runtime.",
                    default: false
                }
            ])
            if (setToken) {
                const { newToken } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'newToken',
                        message: 'Enter your custom Bearer token:'
                    }
                ])
                cfg.adminToken = newToken.trim()
            } else {
                cfg.adminToken = undefined
            }
            saveProjectConfig(projectConfig)
        } else if (action === 'logTime') {
            cfg.logTime = !cfg.logTime
            saveProjectConfig(projectConfig)
        } else if (action === 'logPrefix') {
            const { newPrefix } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'newPrefix',
                    message: 'Enter a new log prefix:',
                    default: cfg.logPrefix || '[LARS OVERLAY ENGINE] '
                }
            ])
            cfg.logPrefix = newPrefix
            saveProjectConfig(projectConfig)
        } else if (action === 'throwFail') {
            cfg.throwOnBroadcastFailure = !cfg.throwOnBroadcastFailure
            saveProjectConfig(projectConfig)
        } else if (action === 'syncConfig') {
            await editSyncConfiguration(cfg)
            saveProjectConfig(projectConfig)
        } else {
            done = true
        }
    }
}

// Helper to interactively edit syncConfiguration
async function editSyncConfiguration(cfg: OverlayAdvancedConfig) {
    cfg.syncConfiguration = cfg.syncConfiguration || {}
    let done = false
    while (!done) {
        console.log(chalk.blue('\nSync Configuration Menu'))
        // Show a list of topics -> user can add, remove, or toggle
        const existingTopics = Object.keys(cfg.syncConfiguration)
        const topicChoices = existingTopics.map(t => {
            const val = cfg.syncConfiguration[t]
            let valDesc = ''
            if (val === false) valDesc = 'false'
            else if (typeof val === 'string') valDesc = val
            else if (Array.isArray(val)) valDesc = JSON.stringify(val)
            else if (val === 'SHIP') valDesc = 'SHIP'
            return { name: `${t}: ${valDesc}`, value: t }
        })
        topicChoices.push({ name: 'Add new topic', value: 'addNewTopic' })
        topicChoices.push({ name: 'Back', value: 'back' })

        const { selectedTopic } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedTopic',
                message: 'Select a topic to edit or add new:',
                choices: topicChoices
            }
        ])

        if (selectedTopic === 'back') {
            done = true
        } else if (selectedTopic === 'addNewTopic') {
            const { newTopic } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'newTopic',
                    message: 'Enter the new topic name:'
                }
            ])
            cfg.syncConfiguration[newTopic.trim()] = 'SHIP' // default
        } else {
            // Toggle or set
            const topicVal = cfg.syncConfiguration[selectedTopic]
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: `Editing "${selectedTopic}" (current: ${JSON.stringify(
                        topicVal
                    )}). Choose an action:`,
                    choices: [
                        { name: 'Set to false (no sync)', value: 'false' },
                        { name: 'Set to SHIP (global discovery)', value: 'SHIP' },
                        { name: 'Set to array of custom endpoints', value: 'array' },
                        { name: 'Remove topic', value: 'remove' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ])

            if (action === 'remove') {
                delete cfg.syncConfiguration[selectedTopic]
            } else if (action === 'false') {
                cfg.syncConfiguration[selectedTopic] = false
            } else if (action === 'SHIP') {
                cfg.syncConfiguration[selectedTopic] = 'SHIP'
            } else if (action === 'array') {
                // Ask for comma separated endpoints
                const { endpoints } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'endpoints',
                        message: 'Enter comma-separated endpoints (e.g. https://peer1,https://peer2):'
                    }
                ])
                const splitted = endpoints
                    .split(',')
                    .map((e: string) => e.trim())
                    .filter((x: string) => !!x)
                cfg.syncConfiguration[selectedTopic] = splitted
            } else {
                // canceled
            }
        }
    }
}

// Edit global keys
async function editGlobalKeys() {
    const keys = loadOrInitGlobalKeys()

    let done = false
    while (!done) {
        console.log(chalk.blue('\nGlobal Keys Menu'))
        console.log(
            chalk.gray('Global keys apply to all LARS projects unless overridden at project level.')
        )
        const choices = [
            {
                name: `Mainnet server key: ${keys.mainnet?.serverPrivateKey ? 'set' : 'not set'}`,
                value: 'm_serverKey'
            },
            {
                name: `Mainnet TAAL (ARC) key: ${keys.mainnet?.taalApiKey ? 'set' : 'not set'}`,
                value: 'm_arcKey'
            },
            {
                name: `Testnet server key: ${keys.testnet?.serverPrivateKey ? 'set' : 'not set'}`,
                value: 't_serverKey'
            },
            {
                name: `Testnet TAAL (ARC) key: ${keys.testnet?.taalApiKey ? 'set' : 'not set'}`,
                value: 't_arcKey'
            },
            { name: 'Back', value: 'back' }
        ]

        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: 'Choose an option:', choices }
        ])

        if (action === 'back') {
            done = true
            continue
        }

        const network = action.startsWith('m_') ? 'mainnet' : 'testnet'
        const field = action.endsWith('serverKey') ? 'serverPrivateKey' : 'taalApiKey'
        if (field === 'serverPrivateKey') {
            keys[network]!.serverPrivateKey = await promptForPrivateKey()
        } else {
            const newArc = await promptForArcApiKey()
            if (newArc) {
                keys[network]!.taalApiKey = newArc
            }
        }
        saveGlobalKeys(keys)
        console.log(chalk.green('Global keys updated.'))
    }
}

// Edit LARS Deployment Info (e.g., change network)
async function editLARSDeploymentInfo(info: CARSConfigInfo) {
    let larsConfig = getLARSConfigFromDeploymentInfo(info)
    if (!larsConfig) {
        console.log(chalk.yellow('No LARS configuration found. Creating one.'))
        await addLARSConfigInteractive(info)
        larsConfig = getLARSConfigFromDeploymentInfo(info)
    }
    if (!larsConfig) {
        console.error(chalk.red('Failed to create/find LARS configuration.'))
        return
    }

    let done = false
    while (!done) {
        const currentNet = larsConfig.network === 'mainnet' ? 'mainnet' : 'testnet'
        const choices = [
            { name: `Change network (current: ${currentNet})`, value: 'network' },
            {
                name: `Edit run configuration (current: ${larsConfig.run?.join(', ') || 'none'})`,
                value: 'runConfig'
            },
            { name: 'Back', value: 'back' }
        ]

        console.log(chalk.blue(`\nLARS Deployment Info Menu (current network: ${currentNet})`))
        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: 'Select an action:', choices }
        ])

        if (action === 'network') {
            const { newNetwork } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'newNetwork',
                    message: 'Select the new network for LARS:',
                    choices: ['mainnet', 'testnet'],
                    default: currentNet
                }
            ])
            if (newNetwork !== currentNet) {
                // Update deployment-info.json
                larsConfig.network = newNetwork
                fs.writeFileSync(DEPLOYMENT_INFO_PATH, JSON.stringify(info, null, 2))
                console.log(chalk.green(`✅ LARS network changed to ${newNetwork}.`))
            } else {
                console.log(chalk.yellow('No change to network.'))
            }
        } else if (action === 'runConfig') {
            // Let user pick which services to run: backend, frontend or both
            const currentRun = larsConfig.run || []
            const { newRun } = await inquirer.prompt([
                {
                    type: 'checkbox',
                    name: 'newRun',
                    message: 'Select which services to run:',
                    choices: [
                        {
                            name: 'backend',
                            value: 'backend',
                            checked: currentRun.includes('backend')
                        },
                        {
                            name: 'frontend',
                            value: 'frontend',
                            checked: currentRun.includes('frontend')
                        }
                    ]
                }
            ])
            larsConfig.run = newRun
            fs.writeFileSync(DEPLOYMENT_INFO_PATH, JSON.stringify(info, null, 2))
            console.log(chalk.green(`✅ LARS run configuration updated to: ${newRun.join(', ') || 'none'}`))
        } else {
            done = true
        }
    }
}

/// //////////////////////////////////////////////////////////////////////////////////
// Main menus
/// //////////////////////////////////////////////////////////////////////////////////

async function mainMenu() {
    const info = loadDeploymentInfo()
    let larsConfig = getLARSConfigFromDeploymentInfo(info)
    const projectConfig = loadProjectConfig()

    if (!larsConfig) {
        console.log(chalk.yellow('No LARS configuration found in deployment-info.json.'))
        // Prompt to create one
        await addLARSConfigInteractive(info)
        larsConfig = getLARSConfigFromDeploymentInfo(info)
    }

    if (!larsConfig) {
        console.error(chalk.red('Failed to create or find LARS configuration.'))
        process.exit(1)
    }

    const network = getCurrentNetwork(larsConfig)

    let done = false
    while (!done) {
        const choices = [
            { name: 'Edit Global Keys', value: 'globalKeys' },
            { name: `Edit Local Project Config (${network})`, value: 'localConfig' },
            { name: 'Edit LARS Deployment Info', value: 'editDeployment' },
            { name: 'Admin Tools (sync, GASP, etc.)', value: 'adminTools' },
            { name: 'Start LARS (local only)', value: 'startLocal' },
            { name: 'Start LARS with ngrok', value: 'startNgrok' },
            { name: 'Reset LARS (remove local-data)', value: 'reset' },
            { name: 'Help', value: 'help' },
            { name: 'Exit', value: 'exit' }
        ]

        console.log(chalk.blue('\nLARS Main Menu'))
        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: 'Select an action:', choices }
        ])

        if (action === 'globalKeys') {
            await editGlobalKeys()
        } else if (action === 'localConfig') {
            await editLocalConfig(projectConfig, getCurrentNetwork(larsConfig))
        } else if (action === 'editDeployment') {
            // Reload info in case user changed configs
            const updatedInfo = loadDeploymentInfo()
            await editLARSDeploymentInfo(updatedInfo)
            larsConfig = getLARSConfigFromDeploymentInfo(updatedInfo)
        } else if (action === 'adminTools') {
            await runAdminTools(projectConfig, larsConfig)
        } else if (action === 'startLocal') {
            await startLARS(larsConfig, projectConfig, false)
        } else if (action === 'startNgrok') {
            await startLARS(larsConfig, projectConfig, true)
        } else if (action === 'reset') {
            await resetLARS()
        } else if (action === 'help') {
            await open('https://github.com/bitcoin-sv/lars')
        } else {
            done = true
        }
    }
}

// Provide a menu to call admin-protected routes on the running OverlayExpress instance.
async function runAdminTools(projectConfig: LARSConfigLocal, larsConfig: CARSConfig) {
    // Then call /admin/syncAdvertisements or /admin/startGASPSync with the Bearer token.
    const baseUrl = 'http://localhost:8080'
    const adminToken = projectConfig.overlayAdvancedConfig?.adminToken

    if (!adminToken) {
        console.log(
            chalk.yellow(
                "No custom adminToken set in overlayAdvancedConfig. If none was generated, the server will generate a random one at startup. You won't be able to use admin routes unless you know it."
            )
        )
    }

    let done = false
    while (!done) {
        const choices = [
            { name: 'Sync Advertisements', value: 'syncAds' },
            { name: 'Start GASP Sync', value: 'startGasp' },
            { name: 'Back', value: 'back' }
        ]
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Admin Tools Menu',
                choices
            }
        ])

        if (action === 'back') {
            done = true
        } else {
            const tokenToUse =
                adminToken ||
                (
                    await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'tempToken',
                            message: 'Enter the admin token (Bearer) for your OverlayExpress instance:'
                        }
                    ])
                ).tempToken

            try {
                if (action === 'syncAds') {
                    const resp = await axios.post(
                        `${baseUrl}/admin/syncAdvertisements`,
                        {},
                        {
                            headers: {
                                Authorization: `Bearer ${tokenToUse}`
                            }
                        }
                    )
                    console.log(
                        chalk.green(
                            `syncAdvertisements responded: ${JSON.stringify(resp.data, null, 2)}`
                        )
                    )
                } else if (action === 'startGasp') {
                    const resp = await axios.post(
                        `${baseUrl}/admin/startGASPSync`,
                        {},
                        {
                            headers: {
                                Authorization: `Bearer ${tokenToUse}`
                            }
                        }
                    )
                    console.log(
                        chalk.green(`startGASPSync responded: ${JSON.stringify(resp.data, null, 2)}`)
                    )
                }
            } catch (err: any) {
                console.log(chalk.red(`❌ Admin route failed: ${err.message}`))
                if (err.response) {
                    console.log(
                        chalk.red(
                            `Server responded with status ${err.response.status}: ${JSON.stringify(
                                err.response.data
                            )}`
                        )
                    )
                }
            }
        }
    }
}

// Add LARS config interactively if none exists
async function addLARSConfigInteractive(info: CARSConfigInfo) {
    console.log(chalk.blue("Let’s create a LARS configuration."))
    const { network } = await inquirer.prompt([
        {
            type: 'list',
            name: 'network',
            message: 'Select network for LARS:',
            choices: ['mainnet', 'testnet'],
            default: 'testnet'
        }
    ])

    const { runServices } = await inquirer.prompt([
        {
            type: 'checkbox',
            name: 'runServices',
            message: 'Which services should LARS run?',
            choices: [
                { name: 'backend', value: 'backend' },
                { name: 'frontend', value: 'frontend' }
            ]
        }
    ])

    const newCfg: CARSConfig = {
        name: 'Local LARS',
        network,
        provider: 'LARS',
        run: runServices
    }
    info.configs = info.configs || []
    info.configs = info.configs.filter(c => c.provider !== 'LARS') // ensure only one LARS config
    info.configs.push(newCfg)
    fs.writeFileSync(DEPLOYMENT_INFO_PATH, JSON.stringify(info, null, 2))
    console.log(
        chalk.green(
            `✅ LARS configuration "Local LARS" created with network: ${network}, running: ${runServices.join(', ')}`
        )
    )
}

// Auto-install frontend dependencies if needed
async function ensureFrontendDependencies(info: CARSConfigInfo) {
    if (!info.frontend || !info.frontend.language) return // no frontend
    const frontendDir = path.resolve(
        PROJECT_ROOT,
        info.frontend.sourceDirectory || 'frontend'
    )
    if (!fs.existsSync(frontendDir)) {
        console.log(chalk.red(`❌ Frontend directory not found at ${frontendDir}.`))
        return
    }

    const packageJsonPath = path.join(frontendDir, 'package.json')
    if (!fs.existsSync(packageJsonPath)) {
        // If no package.json and the language is basic HTML or static, just serve it directly.
        return
    }

    const nodeModulesPath = path.join(frontendDir, 'node_modules')
    if (!fs.existsSync(nodeModulesPath)) {
        console.log(chalk.blue(`📦 Installing frontend dependencies at ${frontendDir}...`))
        try {
            execSync('npm install', { cwd: frontendDir, stdio: 'inherit' })
            console.log(chalk.green('✅ Frontend dependencies installed.'))
        } catch (err) {
            console.error(chalk.red('❌ Failed to install frontend dependencies.'))
        }
    }
}

/// //////////////////////////////////////////////////////////////////////////////////
// Start or reset LARS
/// //////////////////////////////////////////////////////////////////////////////////

async function startLARS(larsConfig: CARSConfig, projectConfig: LARSConfigLocal, withNgrok = false) {
    console.log(chalk.yellow(figlet.textSync('LARS', { horizontalLayout: 'full' })))
    console.log(chalk.green('Welcome to the LARS development environment! 🚀'))
    console.log(chalk.green("Let's get your local Overlay Services up and running!\n"))

    const globalKeys = loadOrInitGlobalKeys()
    const network = getCurrentNetwork(larsConfig)
    const netKeys = projectConfig.projectKeys[network]

    let finalServerKey =
        netKeys.serverPrivateKey || globalKeys[network]?.serverPrivateKey
    const finalArcKey = netKeys.arcApiKey || globalKeys[network]?.taalApiKey

    // If no server key at all, ask user to set either global or project-level:
    if (!finalServerKey) {
        console.log(chalk.yellow(`No server private key found for ${network}.`))
        const useGlobal = await promptYesNo(`Set a global server key for ${network}?`)
        if (useGlobal) {
            const key = await promptForPrivateKey()
            globalKeys[network]!.serverPrivateKey = key
            saveGlobalKeys(globalKeys)
            finalServerKey = key
        } else {
            // set project-level
            const key = await promptForPrivateKey()
            netKeys.serverPrivateKey = key
            saveProjectConfig(projectConfig)
            finalServerKey = key
            await maybeHoistProjectKeyToGlobal(
                key,
                globalKeys[network]?.serverPrivateKey,
                val => {
                    globalKeys[network]!.serverPrivateKey = val
                    saveGlobalKeys(globalKeys)
                },
                'serverPrivateKey',
                network
            )
        }
    }

    if (!finalServerKey) {
        console.error(chalk.red('❌ Server private key is required. Exiting.'))
        process.exit(1)
    }

    // Check Docker dependencies only if we run backend
    const runBackend = larsConfig.run?.includes('backend')
    if (runBackend) {
        console.log(chalk.blue('🔍 Checking system dependencies for backend...'))
        // Docker
        try {
            execSync('docker --version', { stdio: 'ignore' })
        } catch (err) {
            console.error(chalk.red('❌ Docker is not installed or not running.'))
            console.log(chalk.blue('👉 Install Docker: https://docs.docker.com/engine/install/'))
            process.exit(1)
        }
        // Docker Compose
        try {
            execSync('docker compose version', { stdio: 'ignore' })
        } catch (err) {
            console.error(chalk.red('❌ Docker Compose plugin is not installed.'))
            console.log(
                chalk.blue('👉 Install Docker Compose: https://docs.docker.com/compose/install/')
            )
            process.exit(1)
        }
    }

    // If withNgrok is requested, check ngrok
    let hostingUrl = 'localhost:8080'
    if (withNgrok) {
        try {
            execSync('ngrok version', { stdio: 'ignore' })
        } catch (err) {
            console.error(chalk.red('❌ ngrok is not installed.'))
            console.log(chalk.blue('👉 Install ngrok: https://ngrok.com/download'))
            process.exit(1)
        }
    }

    // Check local MetaNet client if the user might want to fund
    let wallet: WalletInterface | undefined
    if (runBackend) {
        wallet = await makeWallet(network === 'testnet' ? 'test' : 'main', finalServerKey)
        const { outputs: outputsInDefaultBasket } = await wallet.listOutputs({ basket: 'default', limit: 10000 })
        const balance = outputsInDefaultBasket.reduce((a, e) => a + e.satoshis, 0)
        if (balance < 10000) {
            console.log(chalk.red(`⚠️  Your server's balance is low: ${balance} satoshis.`))
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: "Your server's balance is low. What would you like to do?",
                    choices: [
                        '💰 Fund server automatically (using local MetaNet Client)',
                        '📝 Print manual funding instructions',
                        '🚀 Continue without funding'
                    ]
                }
            ])

            if (action.startsWith('💰')) {
                const { amountToFund } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'amountToFund',
                        message: 'Enter the amount to fund (in satoshis):',
                        default: '30000',
                        validate: function (value: string) {
                            const valid = !isNaN(parseInt(value)) && parseInt(value) > 0
                            return valid || 'Please enter a positive number.'
                        },
                        filter: Number
                    }
                ])
                await fundWallet(wallet, amountToFund, finalServerKey, network)
                console.log(chalk.green(`🎉 Server funded with ${amountToFund} satoshis.`))
            } else if (action.startsWith('📝')) {
                console.log(chalk.blue('\nManual Funding Instructions:'))
                console.log('1. Use WUI to fund your server.')
                console.log(`2. Your server's wallet private key is: ${finalServerKey}`)
                console.log('3. Visit https://wui.bapp.dev and export funds to the key.')
                await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'wait',
                        message: "Press enter when you're ready to continue."
                    }
                ])
            } else {
                console.log(chalk.yellow('🚀 Continuing without funding.'))
            }
        } else {
            console.log(chalk.green(`✅ Server balance is sufficient: ${balance} satoshis.`))
        }
    }

    // If user specified withNgrok, attempt to connect
    if (withNgrok) {
        console.log(chalk.blue('🌐 Starting ngrok...'))
        const ngrokUrl = await ngrok.connect({ addr: 8080 })
        console.log(chalk.green(`🚀 ngrok tunnel established at ${ngrokUrl}`))
        hostingUrl = new URL(ngrokUrl).host
    }

    // Check if contracts are required
    const info = loadDeploymentInfo()
    let enableContracts = false
    if (info.contracts && info.contracts.language === 'sCrypt') {
        enableContracts = true
    } else if (info.contracts && info.contracts.language && info.contracts.language !== 'sCrypt') {
        console.error(
            chalk.red(`❌ BSV Contract language not supported: ${info.contracts.language}`)
        )
        process.exit(1)
    }

    // Ensure local data dir and write docker-compose.yml (backend only if backend is selected)
    ensureLocalDataDir()
    const runFrontend = larsConfig.run?.includes('frontend')

    // -------------------------------------------------------
    // Keep references to the child processes we spawn:
    let backendLogsProcess: ChildProcess | null = null
    let frontendProcess: ChildProcess | null = null

    // Define a single cleanup routine that stops everything:
    const stopAll = (exitCode?: number) => {
        console.log(chalk.yellow('\nReceived interrupt signal. Stopping LARS...'))
        // 1) Kill the frontend dev process if running
        if (frontendProcess) {
            console.log(chalk.blue('Stopping frontend dev process...'))
            try {
                frontendProcess.kill('SIGINT')
            } catch (err) {
                console.error(chalk.red('Error killing frontend process:'), err)
            }
            frontendProcess = null
        }

        // 2) If the backend was running, bring Docker Compose down
        if (runBackend) {
            try {
                execSync('docker compose down', { cwd: LOCAL_DATA_PATH, stdio: 'inherit' })
            } catch (err) {
                console.error(chalk.red('Error stopping Docker Compose:'), err)
            }
        }

        // Finally exit
        process.exit(exitCode ?? 0)
    }

    // Attach the same cleanup routine to SIGINT / SIGTERM
    process.on('SIGINT', () => stopAll(0))
    process.on('SIGTERM', () => stopAll(0))
    // -------------------------------------------------------

    if (runBackend) {
        // Generate docker-compose with MySQL, Mongo, plus Adminer and mongo-express
        const composeContent = generateDockerCompose(
            hostingUrl,
            LOCAL_DATA_PATH,
            finalServerKey,
            enableContracts,
            network,
            finalArcKey,
            projectConfig.enableRequestLogging,
            projectConfig.enableGASPSync,
            runBackend,
            projectConfig.overlayAdvancedConfig
        )
        const composeYaml = yaml.stringify(composeContent)
        const composeFilePath = path.join(LOCAL_DATA_PATH, 'docker-compose.yml')
        fs.writeFileSync(composeFilePath, composeYaml)
        console.log(chalk.green('✅ docker-compose.yml generated.'))

        // Generate overlay-dev-container files
        console.log(chalk.blue('\n📁 Generating overlay-dev-container files...'))
        const overlayDevContainerPath = path.join(LOCAL_DATA_PATH, 'overlay-dev-container')
        fs.ensureDirSync(overlayDevContainerPath)

        const indexTsContent = generateIndexTs(info, projectConfig, finalArcKey, network)
        fs.writeFileSync(path.join(overlayDevContainerPath, 'index.ts'), indexTsContent)

        // Read backend dependencies if available
        const backendPackageJsonPath = path.resolve(PROJECT_ROOT, 'backend', 'package.json')
        let backendDependencies: Record<string, string> = {}
        if (fs.existsSync(backendPackageJsonPath)) {
            const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, 'utf-8'))
            backendDependencies = backendPackageJson.dependencies || {}
        } else {
            console.warn(chalk.yellow('⚠️  No backend/package.json found.'))
        }

        const packageJsonContent = generatePackageJson(backendDependencies)
        fs.writeFileSync(
            path.join(overlayDevContainerPath, 'package.json'),
            JSON.stringify(packageJsonContent, null, 2)
        )
        fs.writeFileSync(path.join(overlayDevContainerPath, 'tsconfig.json'), generateTsConfig())
        fs.writeFileSync(path.join(overlayDevContainerPath, 'wait-for-services.sh'), generateWaitScript())
        fs.writeFileSync(path.join(overlayDevContainerPath, 'Dockerfile'), generateDockerfile(enableContracts))
        console.log(chalk.green('✅ overlay-dev-container files generated.'))

        // Set up file watchers for backend (contracts compilation triggers, etc.)
        console.log(chalk.blue('\n👀 Setting up backend file watchers...'))
        const backendSrcPath = path.resolve(PROJECT_ROOT, 'backend', 'src')
        if (fs.existsSync(backendSrcPath)) {
            const watcher = chokidar.watch(backendSrcPath, { ignoreInitial: true })
            watcher.on('all', (event, filePath) => {
                console.log(chalk.yellow(`🔄 File ${event}: ${filePath}`))
                if (filePath.includes(path.join('backend', 'src', 'contracts')) && enableContracts) {
                    console.log(
                        chalk.blue('🔨 Changes detected in contracts directory. Running npm run compile...')
                    )
                    const compileProcess = spawn('npm', ['run', 'compile'], {
                        cwd: path.resolve(PROJECT_ROOT, 'backend'),
                        stdio: 'inherit'
                    })

                    compileProcess.on('exit', code => {
                        if (code === 0) {
                            console.log(chalk.green('✅ Contract compilation completed.'))
                        } else {
                            console.error(
                                chalk.red(`❌ Contract compilation failed with exit code ${code}.`)
                            )
                        }
                    })
                }
            })
        } else {
            console.log(chalk.yellow(`No backend src directory found at: ${backendSrcPath}`))
        }

        // Start Docker Compose
        console.log(chalk.blue('\n🐳 Starting Backend Docker Compose...'))
        execSync('docker compose up --build -d', { cwd: LOCAL_DATA_PATH, stdio: 'inherit' })
        backendLogsProcess = spawn('docker', ['compose', 'logs', '-f'], {
            cwd: LOCAL_DATA_PATH,
            stdio: 'inherit'
        })

        // If Docker logs process exits, call stopAll
        backendLogsProcess.on('exit', (code: number) => {
            console.log(chalk.red(`\nBackend logs process exited with code: ${code}`))
            stopAll(code || 0)
        })

        if (runFrontend) {
            // Wait for backend before starting the frontend
            console.log(chalk.blue('⏳ Waiting for backend services to be ready before starting frontend...'))
            await waitForBackendServices()
            // Store the returned ChildProcess reference
            frontendProcess = await startFrontend(info)
        } else {
            console.log(chalk.green('\n🎉 LARS environment (backend only) is ready!'))
        }
    } else if (runFrontend) {
        // If only the frontend is selected:
        frontendProcess = await startFrontend(info)
        console.log(chalk.green('\n🎉 LARS environment (frontend only) is ready!'))
    } else {
        console.log(chalk.yellow('⚠️ You have no backend or frontend configured in LARS run settings.'))
        console.log(chalk.green('Done. Nothing to run.'))
    }
}

// Wait for backend services to be ready
async function waitForBackendServices() {
    // A simple check: we know backend runs on 8080 from Docker.
    // We'll just poll the endpoint until it responds or timeout after some time.
    const maxAttempts = 30
    const waitTime = 2000 // ms
    const url = 'http://localhost:8080'

    console.log(chalk.blue('🔍 Checking backend health endpoint...'))
    for (let i = 0; i < maxAttempts; i++) {
        try {
            await axios.get(url)
            console.log(chalk.green('✅ Backend is ready!'))
            return
        } catch {
            process.stdout.write('.')
            await new Promise(res => setTimeout(res, waitTime))
        }
    }
    console.log(
        chalk.red(`❌ Backend did not become ready after ${(maxAttempts * waitTime) / 1000} seconds.`)
    )

}

async function startFrontend(info: CARSConfigInfo): Promise<ChildProcess | null> {
    if (!info.frontend || !info.frontend.language) {
        console.log(chalk.yellow('⚠️ No frontend configuration found, skipping frontend startup.'))
        return null
    }

    const frontendDir = path.resolve(PROJECT_ROOT, info.frontend.sourceDirectory || 'frontend')
    if (!fs.existsSync(frontendDir)) {
        console.log(chalk.red(`❌ Frontend directory not found at ${frontendDir}, skipping.`))
        return null
    }

    // Ensure dependencies
    await ensureFrontendDependencies(info)

    const { language } = info.frontend
    let childProc: ChildProcess | null = null

    if (language === 'react') {
        console.log(chalk.blue('🎨 Starting React frontend...'))
        // Start `npm run start` in frontendDir
        childProc = spawn('npm', ['run', 'start'], {
            cwd: frontendDir,
            stdio: 'inherit'
        })
        childProc.on('exit', (code: number) => {
            if (code === 0) {
                console.log(chalk.green('🎨 React frontend stopped.'))
            } else {
                console.log(chalk.red(`❌ React frontend exited with code ${code}.`))
            }
        })
    } else if (language === 'html') {
        console.log(chalk.blue('🎨 Starting static HTML frontend...'))
        // Check if 'serve' is installed globally, if not install it
        try {
            execSync('serve -v', { stdio: 'ignore' })
        } catch {
            console.log(chalk.blue('📦 Installing "serve" globally...'))
            try {
                execSync('npm install -g serve', { stdio: 'inherit' })
            } catch (err) {
                console.error(chalk.red('❌ Failed to install "serve" globally.'))
                return null
            }
        }
        childProc = spawn('serve', ['-l', '3000', '.'], {
            cwd: frontendDir,
            stdio: 'inherit'
        })
        childProc.on('exit', (code: number) => {
            if (code === 0) {
                console.log(chalk.green('🎨 Static HTML frontend stopped.'))
            } else {
                console.log(chalk.red(`❌ Static HTML frontend exited with code ${code}`))
            }
        })
    } else {
        console.log(chalk.red(`❌ Frontend language ${language} not supported.`))
        return null
    }

    return childProc
}

/**
 * Generates a Docker Compose config with MySQL, Mongo, Adminer, mongo-express, and overlay-dev-container.
 * Adminer for MySQL on 8081, mongo-express for Mongo on 8082.
 */
function generateDockerCompose(
    hostingUrl: string,
    localDataPath: string,
    serverPrivateKey: string,
    enableContracts: boolean,
    network: 'mainnet' | 'testnet',
    arcApiKey: string | undefined,
    reqLogging: boolean,
    gaspSync: boolean,
    runBackend: boolean,
    advancedConfig?: OverlayAdvancedConfig
) {
    const env: Record<string, string> = {
        MONGO_URL: 'mongodb://mongo:27017/overlay-db',
        KNEX_URL: 'mysql://overlayAdmin:overlay123@mysql:3306/overlay',
        SERVER_PRIVATE_KEY: serverPrivateKey,
        HOSTING_URL: hostingUrl,
        NETWORK: network,
        REQUEST_LOGGING: reqLogging ? 'true' : 'false',
        GASP_SYNC: gaspSync ? 'true' : 'false'
    }
    if (arcApiKey) {
        env.ARC_API_KEY = arcApiKey
    }

    // Pass in advanced engine config as environment variables (where relevant)
    if (advancedConfig?.adminToken) {
        env.ADMIN_BEARER_TOKEN = advancedConfig.adminToken
    }
    if (typeof advancedConfig?.logTime !== 'undefined') {
        env.LOG_TIME = advancedConfig.logTime.toString()
    }
    if (advancedConfig?.logPrefix) {
        env.LOG_PREFIX = advancedConfig.logPrefix
    }
    if (typeof advancedConfig?.throwOnBroadcastFailure !== 'undefined') {
        env.THROW_ON_BROADCAST_FAIL = advancedConfig.throwOnBroadcastFailure.toString()
    }
    if (advancedConfig?.syncConfiguration) {
        // We'll store JSON string of syncConfiguration
        env.SYNC_CONFIG_JSON = JSON.stringify(advancedConfig.syncConfiguration)
    }

    const services: any = {}

    if (runBackend) {
        services['overlay-dev-container'] = {
            build: {
                context: '..',
                dockerfile: './local-data/overlay-dev-container/Dockerfile'
            },
            container_name: 'overlay-dev-container',
            restart: 'always',
            ports: ['8080:8080'],
            environment: env,
            depends_on: ['mysql', 'mongo'],
            volumes: [`${path.resolve(PROJECT_ROOT, 'backend', 'src')}:/app/src`]
        }

        if (enableContracts) {
            services['overlay-dev-container'].volumes.push(
                `${path.resolve(PROJECT_ROOT, 'backend', 'artifacts')}:/app/artifacts`
            )
        }

        // MySQL & Adminer
        services.mysql = {
            image: 'mysql:8.0',
            container_name: 'overlay-mysql',
            environment: {
                MYSQL_DATABASE: 'overlay',
                MYSQL_USER: 'overlayAdmin',
                MYSQL_PASSWORD: 'overlay123',
                MYSQL_ROOT_PASSWORD: 'rootpassword'
            },
            ports: ['3306:3306'],
            volumes: [`${path.resolve(localDataPath, 'mysql')}:/var/lib/mysql`],
            healthcheck: {
                test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
                interval: '10s',
                timeout: '5s',
                retries: 3
            }
        }
        services.adminer = {
            image: 'adminer',
            container_name: 'overlay-adminer',
            restart: 'always',
            ports: ['8081:8080'],
            environment: {
                ADMINER_DEFAULT_SERVER: 'mysql'
            },
            depends_on: ['mysql']
        }

        // Mongo & mongo-express
        services.mongo = {
            image: 'mongo:6.0',
            container_name: 'overlay-mongo',
            ports: ['27017:27017'],
            volumes: [`${path.resolve(localDataPath, 'mongo')}:/data/db`],
            command: ['mongod', '--quiet']
        }
        services.mongoexpress = {
            image: 'mongo-express',
            container_name: 'overlay-mongo-express',
            restart: 'always',
            ports: ['8082:8081'],
            environment: {
                ME_CONFIG_MONGODB_SERVER: 'mongo',
                ME_CONFIG_MONGODB_PORT: '27017',
                ME_CONFIG_BASICAUTH_USERNAME: '',
                ME_CONFIG_BASICAUTH_PASSWORD: ''
            },
            depends_on: ['mongo']
        }
    }

    const composeContent: any = { services }
    return composeContent
}

function generateIndexTs(
    info: CARSConfigInfo,
    config: LARSConfigLocal,
    arcApiKey: string | undefined,
    network: 'mainnet' | 'testnet'
): string {
    let imports = `
import OverlayExpress from '@bsv/overlay-express'
`

    // We'll read advanced config from environment variables
    // so that our server automatically picks them up when launched in Docker.
    let mainFunction = `
const main = async () => {
    const adminToken = process.env.ADMIN_BEARER_TOKEN; // may be undefined
    const server = new OverlayExpress(
        \`LARS\`,
        process.env.SERVER_PRIVATE_KEY!,
        process.env.HOSTING_URL!,
        adminToken
    )

    server.configurePort(8080)
    server.configureVerboseRequestLogging(process.env.REQUEST_LOGGING === 'true')
    server.configureNetwork(process.env.NETWORK === 'mainnet' ? 'main' : 'test')
    await server.configureKnex(process.env.KNEX_URL!)
    await server.configureMongo(process.env.MONGO_URL!)
    server.configureEnableGASPSync(process.env.GASP_SYNC === 'true')

    if (process.env.ARC_API_KEY) {
      server.configureArcApiKey(process.env.ARC_API_KEY)
    }

    // Apply advanced engine config from environment
    const logTime = process.env.LOG_TIME === 'true'
    const logPrefix = process.env.LOG_PREFIX || '[LARS OVERLAY ENGINE] '
    const throwOnBroadcastFailure = process.env.THROW_ON_BROADCAST_FAIL === 'true'
    let parsedSyncConfig = {}
    if (process.env.SYNC_CONFIG_JSON) {
      try {
        parsedSyncConfig = JSON.parse(process.env.SYNC_CONFIG_JSON)
      } catch(e) {
        console.error('Failed to parse SYNC_CONFIG_JSON:', e)
      }
    }

    server.configureEngineParams({
      logTime,
      logPrefix,
      throwOnBroadcastFailure,
      syncConfiguration: parsedSyncConfig
    })
`

    // For each topic manager
    for (const [name, pathToTm] of Object.entries(info.topicManagers || {})) {
        const importName = `tm_${name}`
        const pathToTmInContainer = path
            .join('/app', path.relative(process.cwd(), pathToTm))
            .replace(/\\/g, '/')
            .replace('/backend/', '/')
        imports += `import ${importName} from '${pathToTmInContainer}'\n`
        mainFunction += `    server.configureTopicManager('${name}', new ${importName}())\n`
    }

    // For each lookup service
    for (const [name, lsConfig] of Object.entries(info.lookupServices || {})) {
        const importName = `lsf_${name}`
        const pathToLsInContainer = path
            .join('/app', path.relative(process.cwd(), lsConfig.serviceFactory))
            .replace(/\\/g, '/')
            .replace('/backend/', '/')
        imports += `import ${importName} from '${pathToLsInContainer}'\n`
        if (lsConfig.hydrateWith === 'mongo') {
            mainFunction += `    server.configureLookupServiceWithMongo('${name}', ${importName})\n`
        } else if (lsConfig.hydrateWith === 'knex') {
            mainFunction += `    server.configureLookupServiceWithKnex('${name}', ${importName})\n`
        } else {
            mainFunction += `    server.configureLookupService('${name}', ${importName}())\n`
        }
    }

    const closing = `
    await server.configureEngine()
    await server.start()
}

main()
`

    return imports + mainFunction + closing
}

function generatePackageJson(backendDependencies: Record<string, string>) {
    const packageJsonContent = {
        name: 'overlay-express-dev',
        version: '1.0.0',
        description: '',
        main: 'index.ts',
        scripts: {
            start: 'tsx watch index.ts'
        },
        keywords: [],
        author: '',
        license: 'ISC',
        dependencies: {
            ...backendDependencies,
            '@bsv/overlay-express': '^0.3.16',
            mysql2: '^3.11.5',
            tsx: '^4.19.2'
        },
        devDependencies: {
            '@types/node': '^22.10.1'
        }
    }
    return packageJsonContent
}

function generateDockerfile(enableContracts: boolean) {
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

EXPOSE 8080
CMD ["/wait-for-services.sh", "mysql", "3306", "mongo", "27017", "npm", "run", "start"]`
    return file
}

function generateTsConfig() {
    return `{
    "compilerOptions": {
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true
    }
}`
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

/**
 * Deletes the local-data directory after confirmation, or immediately if --force
 */
async function resetLARS(force?: boolean) {
    const proceed =
        force ||
        (await promptYesNo(
            'Are you sure you want to reset LARS? This will remove the entire local-data folder, destroying all local databases.',
            false
        ))
    if (!proceed) {
        console.log(chalk.yellow('Reset canceled.'))
        return
    }

    if (fs.existsSync(LOCAL_DATA_PATH)) {
        console.log(chalk.blue('Stopping Docker Compose (if running)...'))
        try {
            execSync('docker compose down', { cwd: LOCAL_DATA_PATH, stdio: 'ignore' })
        } catch { }
        console.log(chalk.blue(`Removing local-data directory at: ${LOCAL_DATA_PATH}`))
        fs.removeSync(LOCAL_DATA_PATH)
        console.log(chalk.green('✅ LARS has been reset.'))
    } else {
        console.log(chalk.yellow(`No local-data directory found at ${LOCAL_DATA_PATH}. Nothing to remove.`))
    }
}

/// //////////////////////////////////////////////////////////////////////////////////
// CLI Commands
/// //////////////////////////////////////////////////////////////////////////////////

program
    .command('config')
    .description('Manage LARS configuration (global keys, local config, and deployment info)')
    .action(async () => {
        // Show a config-focused menu:
        const info = loadDeploymentInfo()
        let larsConfig = getLARSConfigFromDeploymentInfo(info)
        if (!larsConfig) {
            console.log(chalk.yellow('No LARS configuration found. Creating one.'))
            await addLARSConfigInteractive(info)
            larsConfig = getLARSConfigFromDeploymentInfo(info)
        }
        if (!larsConfig) {
            console.error(chalk.red('Failed to create/find LARS configuration.'))
            process.exit(1)
        }
        const projectConfig = loadProjectConfig()

        let done = false
        while (!done) {
            const network = getCurrentNetwork(larsConfig)
            const choices = [
                { name: 'Edit Global Keys', value: 'globalKeys' },
                { name: `Edit Local Project Config (${network})`, value: 'localConfig' },
                { name: 'Edit LARS Deployment Info', value: 'editDeployment' },
                { name: 'Back to main menu', value: 'back' }
            ]

            console.log(chalk.blue('\nLARS Config Menu'))
            const { action } = await inquirer.prompt([
                { type: 'list', name: 'action', message: 'Select an action:', choices }
            ])

            if (action === 'globalKeys') {
                await editGlobalKeys()
            } else if (action === 'localConfig') {
                await editLocalConfig(projectConfig, getCurrentNetwork(larsConfig))
            } else if (action === 'editDeployment') {
                const updatedInfo = loadDeploymentInfo()
                await editLARSDeploymentInfo(updatedInfo)
                larsConfig = getLARSConfigFromDeploymentInfo(updatedInfo)
            } else {
                done = true
            }
        }
    })

program
    .command('start')
    .description('Start LARS development environment (local only by default)')
    .option('--with-ngrok', 'Use ngrok instead of localhost')
    .action(async (opts) => {
        const info = loadDeploymentInfo()
        let larsConfig = getLARSConfigFromDeploymentInfo(info)
        if (!larsConfig) {
            console.log(chalk.yellow('No LARS configuration found. Creating one.'))
            await addLARSConfigInteractive(info)
            larsConfig = getLARSConfigFromDeploymentInfo(info)
        }
        if (!larsConfig) {
            console.error(chalk.red('Failed to create/find LARS configuration.'))
            process.exit(1)
        }
        const projectConfig = loadProjectConfig()
        await startLARS(larsConfig, projectConfig, !!opts.with_ngrok)
    })

program
    .command('reset')
    .description('Remove the local-data folder (and all local LARS data)')
    .option('--force', 'Perform the reset without prompting for confirmation')
    .action(async (opts) => {
        await resetLARS(opts.force)
    })

// Default action => main menu
program.action(async () => {
    await mainMenu()
})

program.parse(process.argv)
