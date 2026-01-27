#!/usr/bin/env node
/**
 * Manifest Monitor - Automatically generates manifest.json permissions
 * by intercepting wallet requests from a local development frontend.
 * 
 * Usage:
 *   lars manifest-monitor [options]
 * 
 * This tool runs a proxy server that sits between your frontend and the wallet,
 * capturing all wallet API calls and extracting the permissions your app needs.
 */

import http from 'http'
import https from 'https'
import fs from 'fs-extra'
import path from 'path'
import chalk from 'chalk'

// Types for manifest structure
interface ProtocolPermission {
  protocolID: [number, string]
  counterparty: string
  description: string
}

interface BasketAccess {
  basket: string
  description: string
}

interface CertificateAccess {
  type: string
  certifier?: string
  description: string
}

interface LabelAccess {
  label: string
  description: string
}

interface GroupPermissions {
  protocolPermissions: ProtocolPermission[]
  basketAccess: BasketAccess[]
  certificateAccess?: CertificateAccess[]
  labelAccess?: LabelAccess[]
}

interface ManifestBabbage {
  groupPermissions: GroupPermissions
}

interface Manifest {
  short_name?: string
  name?: string
  icons?: Array<{ src: string; sizes: string; type: string }>
  start_url?: string
  display?: string
  theme_color?: string
  background_color?: string
  babbage: ManifestBabbage
}

// Collected permissions during monitoring session
const collectedPermissions: GroupPermissions = {
  protocolPermissions: [],
  basketAccess: [],
  certificateAccess: [],
  labelAccess: []
}

// Track unique permissions to avoid duplicates
const seenProtocolPermissions = new Set<string>()
const seenBasketAccess = new Set<string>()
const seenCertificateAccess = new Set<string>()
const seenLabelAccess = new Set<string>()

/**
 * Generate a unique key for a protocol permission
 */
function getProtocolPermissionKey(protocolID: [number, string], counterparty: string): string {
  return `${protocolID[0]}:${protocolID[1]}:${counterparty}`
}

/**
 * Extract protocol permissions from wallet API call arguments
 */
function extractProtocolPermission(
  method: string,
  args: Record<string, unknown>
): ProtocolPermission | null {
  // Methods that use protocolID
  const protocolMethods = [
    'getPublicKey',
    'encrypt',
    'decrypt',
    'createHmac',
    'verifyHmac',
    'createSignature',
    'verifySignature',
    'revealSpecificKeyLinkage'
  ]

  if (!protocolMethods.includes(method)) {
    return null
  }

  const protocolID = args.protocolID as [number, string] | undefined
  if (!protocolID || !Array.isArray(protocolID) || protocolID.length !== 2) {
    return null
  }

  // Determine counterparty - default to 'self' if not specified
  let counterparty = 'self'
  if (args.counterparty !== undefined) {
    counterparty = args.counterparty as string
  }

  // Generate description based on method
  const descriptions: Record<string, string> = {
    getPublicKey: `Derive public key for protocol "${protocolID[1]}"`,
    encrypt: `Encrypt data using protocol "${protocolID[1]}"`,
    decrypt: `Decrypt data using protocol "${protocolID[1]}"`,
    createHmac: `Create HMAC using protocol "${protocolID[1]}"`,
    verifyHmac: `Verify HMAC using protocol "${protocolID[1]}"`,
    createSignature: `Create signature using protocol "${protocolID[1]}"`,
    verifySignature: `Verify signature using protocol "${protocolID[1]}"`,
    revealSpecificKeyLinkage: `Reveal key linkage for protocol "${protocolID[1]}"`
  }

  return {
    protocolID,
    counterparty,
    description: descriptions[method] || `Permission for protocol "${protocolID[1]}"`
  }
}

/**
 * Extract basket access from wallet API call arguments
 */
function extractBasketAccess(
  method: string,
  args: Record<string, unknown>
): BasketAccess | null {
  const basketMethods = ['listOutputs', 'relinquishOutput']

  if (!basketMethods.includes(method)) {
    return null
  }

  const basket = args.basket as string | undefined
  if (!basket) {
    return null
  }

  return {
    basket,
    description: `Access to "${basket}" basket for ${method === 'listOutputs' ? 'reading outputs' : 'managing outputs'}`
  }
}

/**
 * Extract certificate access from wallet API call arguments
 */
function extractCertificateAccess(
  method: string,
  args: Record<string, unknown>
): CertificateAccess | null {
  const certMethods = ['listCertificates', 'acquireCertificate', 'proveCertificate', 'relinquishCertificate']

  if (!certMethods.includes(method)) {
    return null
  }

  // For listCertificates, types is an array
  if (method === 'listCertificates') {
    const types = args.types as string[] | undefined
    if (types && types.length > 0) {
      return {
        type: types[0], // Take first type for now
        description: `List certificates of specified types`
      }
    }
  }

  // For other methods, type is a single value
  const type = args.type as string | undefined
  if (type) {
    const certifier = args.certifier as string | undefined
    return {
      type,
      certifier,
      description: `${method.replace('Certificate', '')} certificate of type "${type}"`
    }
  }

  return null
}

/**
 * Extract label access from createAction calls
 */
function extractLabelAccess(
  method: string,
  args: Record<string, unknown>
): LabelAccess[] {
  if (method !== 'createAction') {
    return []
  }

  const labels: LabelAccess[] = []

  // Check for labels in outputs
  const outputs = args.outputs as Array<{ tags?: string[] }> | undefined
  if (outputs) {
    for (const output of outputs) {
      if (output.tags) {
        for (const tag of output.tags) {
          labels.push({
            label: tag,
            description: `Label outputs with "${tag}"`
          })
        }
      }
    }
  }

  // Check for labels in the action itself
  const actionLabels = args.labels as string[] | undefined
  if (actionLabels) {
    for (const label of actionLabels) {
      labels.push({
        label,
        description: `Label action with "${label}"`
      })
    }
  }

  return labels
}

/**
 * Process a wallet API request and extract permissions
 */
function processWalletRequest(method: string, args: Record<string, unknown>): void {
  // Extract protocol permission
  const protocolPerm = extractProtocolPermission(method, args)
  if (protocolPerm) {
    const key = getProtocolPermissionKey(protocolPerm.protocolID, protocolPerm.counterparty)
    if (!seenProtocolPermissions.has(key)) {
      seenProtocolPermissions.add(key)
      collectedPermissions.protocolPermissions.push(protocolPerm)
      console.log(chalk.green(`  ✓ Protocol: [${protocolPerm.protocolID[0]}, "${protocolPerm.protocolID[1]}"] → ${protocolPerm.counterparty}`))
    }
  }

  // Extract basket access
  const basketPerm = extractBasketAccess(method, args)
  if (basketPerm) {
    if (!seenBasketAccess.has(basketPerm.basket)) {
      seenBasketAccess.add(basketPerm.basket)
      collectedPermissions.basketAccess.push(basketPerm)
      console.log(chalk.green(`  ✓ Basket: "${basketPerm.basket}"`))
    }
  }

  // Extract certificate access
  const certPerm = extractCertificateAccess(method, args)
  if (certPerm) {
    const key = `${certPerm.type}:${certPerm.certifier || ''}`
    if (!seenCertificateAccess.has(key)) {
      seenCertificateAccess.add(key)
      collectedPermissions.certificateAccess!.push(certPerm)
      console.log(chalk.green(`  ✓ Certificate: "${certPerm.type}"`))
    }
  }

  // Extract label access
  const labelPerms = extractLabelAccess(method, args)
  for (const labelPerm of labelPerms) {
    if (!seenLabelAccess.has(labelPerm.label)) {
      seenLabelAccess.add(labelPerm.label)
      collectedPermissions.labelAccess!.push(labelPerm)
      console.log(chalk.green(`  ✓ Label: "${labelPerm.label}"`))
    }
  }
}

/**
 * Create or update manifest.json with collected permissions
 */
function saveManifest(outputPath: string, appName: string): void {
  let manifest: Manifest

  // Try to load existing manifest
  if (fs.existsSync(outputPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(outputPath, 'utf-8'))
      // Ensure babbage section exists
      if (!manifest.babbage) {
        manifest.babbage = { groupPermissions: { protocolPermissions: [], basketAccess: [] } }
      }
    } catch {
      manifest = createDefaultManifest(appName)
    }
  } else {
    manifest = createDefaultManifest(appName)
  }

  // Update permissions
  manifest.babbage.groupPermissions = {
    protocolPermissions: collectedPermissions.protocolPermissions,
    basketAccess: collectedPermissions.basketAccess
  }

  // Only include certificate and label access if they have entries
  if (collectedPermissions.certificateAccess && collectedPermissions.certificateAccess.length > 0) {
    manifest.babbage.groupPermissions.certificateAccess = collectedPermissions.certificateAccess
  }
  if (collectedPermissions.labelAccess && collectedPermissions.labelAccess.length > 0) {
    manifest.babbage.groupPermissions.labelAccess = collectedPermissions.labelAccess
  }

  // Write manifest
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2))
  console.log(chalk.blue(`\n📝 Manifest saved to: ${outputPath}`))
}

/**
 * Create a default manifest structure
 */
function createDefaultManifest(appName: string): Manifest {
  return {
    short_name: appName,
    name: appName,
    icons: [
      {
        src: 'favicon.ico',
        sizes: '64x64 32x32 24x24 16x16',
        type: 'image/x-icon'
      }
    ],
    start_url: '.',
    display: 'standalone',
    theme_color: '#000000',
    background_color: '#ffffff',
    babbage: {
      groupPermissions: {
        protocolPermissions: [],
        basketAccess: []
      }
    }
  }
}

/**
 * Start the manifest monitor proxy server
 */
export async function startManifestMonitor(options: {
  proxyPort?: number
  walletPort?: number
  walletHost?: string
  outputPath?: string
  appName?: string
  useHttps?: boolean
}): Promise<http.Server> {
  const {
    proxyPort = 3322,
    walletPort = 3321,
    walletHost = 'localhost',
    outputPath = path.join(process.cwd(), 'frontend', 'public', 'manifest.json'),
    appName = path.basename(process.cwd()),
    useHttps = false
  } = options

  console.log(chalk.yellow('\n🔍 Manifest Monitor'))
  console.log(chalk.yellow('=================='))
  console.log(chalk.blue(`Proxy listening on: http://localhost:${proxyPort}`))
  console.log(chalk.blue(`Forwarding to wallet: http${useHttps ? 's' : ''}://${walletHost}:${walletPort}`))
  console.log(chalk.blue(`Output manifest: ${outputPath}`))
  console.log(chalk.gray('\nMonitoring wallet requests... Press Ctrl+C to stop and save.\n'))

  const server = http.createServer(async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Origin, Originator')

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Collect request body
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', () => {
      // Extract method name from URL
      const method = req.url?.slice(1) || 'unknown'

      // Parse and process the request
      let args: Record<string, unknown> = {}
      try {
        if (body) {
          args = JSON.parse(body)
        }
      } catch {
        // Ignore parse errors
      }

      // Log the request
      console.log(chalk.cyan(`→ ${method}`))

      // Process for permissions
      processWalletRequest(method, args)

      // Forward to actual wallet
      const walletReq = (useHttps ? https : http).request(
        {
          hostname: walletHost,
          port: walletPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${walletHost}:${walletPort}`
          }
        },
        walletRes => {
          // Forward response headers
          res.writeHead(walletRes.statusCode || 200, walletRes.headers)

          // Forward response body
          walletRes.pipe(res)
        }
      )

      walletReq.on('error', err => {
        console.error(chalk.red(`  ✗ Wallet error: ${err.message}`))
        res.writeHead(502)
        res.end(JSON.stringify({ error: 'Failed to connect to wallet', message: err.message }))
      })

      // Send request body to wallet
      if (body) {
        walletReq.write(body)
      }
      walletReq.end()
    })
  })

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(chalk.yellow('\n\n🛑 Stopping monitor...'))

    // Print summary
    console.log(chalk.blue('\n📊 Permission Summary:'))
    console.log(chalk.gray(`  Protocol Permissions: ${collectedPermissions.protocolPermissions.length}`))
    console.log(chalk.gray(`  Basket Access: ${collectedPermissions.basketAccess.length}`))
    console.log(chalk.gray(`  Certificate Access: ${collectedPermissions.certificateAccess?.length || 0}`))
    console.log(chalk.gray(`  Label Access: ${collectedPermissions.labelAccess?.length || 0}`))

    // Save manifest
    saveManifest(outputPath, appName)

    server.close(() => {
      console.log(chalk.green('\n✅ Manifest monitor stopped.'))
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return new Promise((resolve, reject) => {
    server.listen(proxyPort, () => {
      resolve(server)
    })
    server.on('error', reject)
  })
}

/**
 * Print instructions for using the manifest monitor
 */
export function printUsageInstructions(_proxyPort: number): void {
  console.log(chalk.yellow('\n📋 How to Use:'))
  console.log(chalk.gray('─'.repeat(50)))
  console.log(chalk.white(`
${chalk.bold('Waiting for wallet requests...')}

The proxy is forwarding requests from port 3322 → 3321.
Use your app and press Ctrl+C when done to save the manifest.
`))
  console.log(chalk.gray('─'.repeat(50)))
}

/**
 * Print the browser console snippet for easy copy-paste
 */
export function printBrowserSnippet(): void {
  const snippet = `(function(){const p={protocolPermissions:[],basketAccess:[],certificateAccess:[]};const s={protocol:new Set(),basket:new Set(),cert:new Set()};const pm=['getPublicKey','encrypt','decrypt','createHmac','verifyHmac','createSignature','verifySignature','revealSpecificKeyLinkage'];const bm=['listOutputs','relinquishOutput'];const cm=['listCertificates','acquireCertificate','proveCertificate','relinquishCertificate'];const of=window.fetch;window.fetch=async function(i,n){const u=typeof i==='string'?i:i.url||i.href;if(u.includes('localhost:3321')||u.includes('127.0.0.1:3321')){const m=new URL(u).pathname.slice(1);let a={};try{if(n?.body)a=JSON.parse(n.body)}catch{}console.log('%c→ '+m,'color:cyan');if(pm.includes(m)&&a.protocolID){const[sec,name]=a.protocolID;const cp=a.counterparty||'self';const k=sec+':'+name+':'+cp;if(!s.protocol.has(k)){s.protocol.add(k);p.protocolPermissions.push({protocolID:[sec,name],counterparty:cp,description:m+' using "'+name+'"'});console.log('%c✓ Protocol: ['+sec+', "'+name+'"] → '+cp,'color:green')}}if(bm.includes(m)&&a.basket&&!s.basket.has(a.basket)){s.basket.add(a.basket);p.basketAccess.push({basket:a.basket,description:'Access to "'+a.basket+'"'});console.log('%c✓ Basket: "'+a.basket+'"','color:green')}if(cm.includes(m)){const t=a.type||(a.types&&a.types[0]);if(t&&!s.cert.has(t)){s.cert.add(t);p.certificateAccess.push({type:t,certifier:a.certifier,description:m+' for "'+t+'"'});console.log('%c✓ Certificate: "'+t+'"','color:green')}}}return of.call(window,i,n)};window.generateManifest=(n='MyApp')=>{const m={short_name:n,name:n,icons:[{src:'favicon.ico',sizes:'64x64 32x32 24x24 16x16',type:'image/x-icon'}],start_url:'.',display:'standalone',theme_color:'#000000',background_color:'#ffffff',babbage:{groupPermissions:{protocolPermissions:p.protocolPermissions,basketAccess:p.basketAccess,...(p.certificateAccess.length>0&&{certificateAccess:p.certificateAccess})}}};const j=JSON.stringify(m,null,2);console.log(j);return j};window.copyManifest=async(n='MyApp')=>{await navigator.clipboard.writeText(window.generateManifest(n));console.log('%c✅ Copied!','color:green;font-weight:bold')};console.log('%c🔍 Manifest Monitor Active','color:yellow;font-weight:bold;font-size:14px');console.log('%cRun copyManifest("AppName") when done','color:gray')})();`

  console.log(chalk.yellow('\n🔍 Manifest Monitor - Browser Method'))
  console.log(chalk.gray('─'.repeat(60)))
  console.log(chalk.white(`
${chalk.bold('1.')} Open your app in the browser
${chalk.bold('2.')} Open DevTools (F12) → Console tab
${chalk.bold('3.')} Paste this snippet and press Enter:
`))
  console.log(chalk.cyan(snippet))
  console.log(chalk.white(`
${chalk.bold('4.')} Use your app - click through all wallet features
${chalk.bold('5.')} Run ${chalk.green('copyManifest("YourAppName")')} to copy the manifest
${chalk.bold('6.')} Paste into your manifest.json file
`))
  console.log(chalk.gray('─'.repeat(60)))
}

/**
 * Generate a vite proxy configuration for the manifest monitor
 */
export function generateViteProxyConfig(proxyPort: number = 3322): Record<string, string> {
  const walletMethods = [
    'createAction', 'signAction', 'abortAction', 'listActions', 'internalizeAction',
    'listOutputs', 'relinquishOutput', 'getPublicKey', 'revealCounterpartyKeyLinkage',
    'revealSpecificKeyLinkage', 'encrypt', 'decrypt', 'createHmac', 'verifyHmac',
    'createSignature', 'verifySignature', 'acquireCertificate', 'listCertificates',
    'proveCertificate', 'relinquishCertificate', 'discoverByIdentityKey',
    'discoverByAttributes', 'isAuthenticated', 'waitForAuthentication',
    'getHeight', 'getHeaderForHeight', 'getNetwork', 'getVersion'
  ]

  const config: Record<string, string> = {}
  for (const method of walletMethods) {
    config[`/${method}`] = `http://localhost:${proxyPort}`
  }
  return config
}

// CLI entry point when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const proxyPort = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] || '3322')
  const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1]

  startManifestMonitor({ proxyPort, outputPath })
    .then(() => printUsageInstructions(proxyPort))
    .catch(err => {
      console.error(chalk.red('Failed to start manifest monitor:'), err)
      process.exit(1)
    })
}
