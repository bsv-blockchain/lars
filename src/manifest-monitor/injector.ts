/**
 * Manifest Monitor Injector
 * 
 * This module provides:
 * 1. A small HTTP server that receives permission data from the browser
 * 2. Auto-writes to manifest.json when permissions are collected
 * 3. An injectable script for the browser
 */

import http from 'http'
import fs from 'fs-extra'
import path from 'path'
import chalk from 'chalk'

/**
 * Default descriptions for common protocols
 * Based on manifest-studio package permission templates
 */
const PROTOCOL_DESCRIPTIONS: Record<string, { description: string, counterpartyType?: 'self' | 'server' | 'any' }> = {
  // Authentication & Security
  'auth message signature': {
    description: 'For mutual authentication with servers',
    counterpartyType: 'server'
  },
  'server hmac': {
    description: 'For nonce generation and HMAC creation',
    counterpartyType: 'self'
  },

  // Messaging
  'messagebox': {
    description: 'For message delivery and communication',
    counterpartyType: 'server'
  },

  // Payments
  '3241645161d8': {
    description: 'For payment transactions',
    counterpartyType: 'any'
  },

  // Identity
  'identity key retrieval': {
    description: 'For identity resolution and verification',
    counterpartyType: 'any'
  },
  'certificate list': {
    description: 'For certificate registry access',
    counterpartyType: 'any'
  },

  // Storage & Data
  'contact': {
    description: 'For contact management and encryption',
    counterpartyType: 'self'
  },
  'wallet settings': {
    description: 'For wallet configuration and preferences',
    counterpartyType: 'self'
  },

  // Tokens
  'PushDrop': {
    description: 'For token transactions',
    counterpartyType: 'any'
  }
}

/**
 * Generate a better description for a protocol permission
 */
function getProtocolDescription(protocolID: [number, string], counterparty: string, method: string): string {
  const protocolName = protocolID[1]
  const defaultInfo = PROTOCOL_DESCRIPTIONS[protocolName]

  if (defaultInfo) {
    return defaultInfo.description
  }

  // Fallback to method-based description
  return `${method} using "${protocolName}"`
}

interface CollectedPermissions {
  protocolPermissions: Array<{
    protocolID: [number, string]
    counterparty: string
    description: string
  }>
  basketAccess: Array<{
    basket: string
    description: string
  }>
  certificateAccess: Array<{
    type: string
    certifier?: string
    description: string
  }>
}

let collectorServer: http.Server | null = null
let manifestPath: string = ''
let appName: string = 'MyApp'

// Track all collected permissions across browser refreshes
const allPermissions: CollectedPermissions = {
  protocolPermissions: [],
  basketAccess: [],
  certificateAccess: []
}
const seen = {
  protocol: new Set<string>(),
  basket: new Set<string>(),
  cert: new Set<string>()
}

/**
 * Start the permission collector server
 */
export function startCollectorServer(options: {
  port?: number
  outputPath: string
  name: string
}): Promise<void> {
  const port = options.port || 3399
  manifestPath = options.outputPath
  appName = options.name

  return new Promise((resolve, reject) => {
    collectorServer = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/collect') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as {
              type: 'protocol' | 'basket' | 'certificate'
              permission: unknown
            }

            if (data.type === 'protocol') {
              const perm = data.permission as CollectedPermissions['protocolPermissions'][0]
              const key = `${perm.protocolID[0]}:${perm.protocolID[1]}:${perm.counterparty}`
              if (!seen.protocol.has(key)) {
                seen.protocol.add(key)
                allPermissions.protocolPermissions.push(perm)
                console.log(chalk.green(`  ✓ Protocol: [${perm.protocolID[0]}, "${perm.protocolID[1]}"] → ${perm.counterparty}`))
                saveManifest()
              }
            } else if (data.type === 'basket') {
              const perm = data.permission as CollectedPermissions['basketAccess'][0]
              if (!seen.basket.has(perm.basket)) {
                seen.basket.add(perm.basket)
                allPermissions.basketAccess.push(perm)
                console.log(chalk.green(`  ✓ Basket: "${perm.basket}"`))
                saveManifest()
              }
            } else if (data.type === 'certificate') {
              const perm = data.permission as CollectedPermissions['certificateAccess'][0]
              if (!seen.cert.has(perm.type)) {
                seen.cert.add(perm.type)
                allPermissions.certificateAccess.push(perm)
                console.log(chalk.green(`  ✓ Certificate: "${perm.type}"`))
                saveManifest()
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: 'Invalid JSON' }))
          }
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    collectorServer.listen(port, () => {
      console.log(chalk.yellow(`\n🔍 Permission Monitor Active`))
      console.log(chalk.gray(`   Collector server on http://localhost:${port}`))
      console.log(chalk.gray(`   Writing to: ${manifestPath}`))
      console.log(chalk.gray(`   Use your app - permissions will be auto-saved\n`))
      resolve()
    })

    collectorServer.on('error', reject)
  })
}

/**
 * Stop the collector server
 */
export function stopCollectorServer(): void {
  if (collectorServer) {
    collectorServer.close()
    collectorServer = null
    console.log(chalk.yellow('\n🛑 Permission Monitor stopped'))
    printSummary()
  }
}

/**
 * Print summary of collected permissions
 */
function printSummary(): void {
  console.log(chalk.blue('\n📊 Permission Summary:'))
  console.log(chalk.gray(`   Protocol Permissions: ${allPermissions.protocolPermissions.length}`))
  console.log(chalk.gray(`   Basket Access: ${allPermissions.basketAccess.length}`))
  console.log(chalk.gray(`   Certificate Access: ${allPermissions.certificateAccess.length}`))
  console.log(chalk.blue(`\n📝 Manifest saved to: ${manifestPath}\n`))
}

/**
 * Save collected permissions to manifest.json
 */
function saveManifest(): void {
  let manifest: Record<string, unknown>

  // Try to load existing manifest
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch {
      manifest = createDefaultManifest()
    }
  } else {
    manifest = createDefaultManifest()
  }

  // Ensure babbage section exists
  if (!manifest.babbage) {
    manifest.babbage = { groupPermissions: {} }
  }
  const babbage = manifest.babbage as { groupPermissions: Record<string, unknown> }

  // Update permissions
  babbage.groupPermissions = {
    protocolPermissions: allPermissions.protocolPermissions,
    basketAccess: allPermissions.basketAccess
  }

  if (allPermissions.certificateAccess.length > 0) {
    babbage.groupPermissions.certificateAccess = allPermissions.certificateAccess
  }

  // Ensure directory exists
  fs.ensureDirSync(path.dirname(manifestPath))

  // Write manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

/**
 * Create default manifest structure
 */
function createDefaultManifest(): Record<string, unknown> {
  return {
    short_name: appName,
    name: appName,
    icons: [
      { src: 'favicon.ico', sizes: '64x64 32x32 24x24 16x16', type: 'image/x-icon' }
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
 * Get the browser injection script
 * This script intercepts fetch calls and sends permissions to the collector server
 */
export function getInjectionScript(collectorPort: number = 3399): string {
  return `
<script>
(function() {
  const COLLECTOR_URL = 'http://localhost:${collectorPort}/collect';
  const pm = ['getPublicKey','encrypt','decrypt','createHmac','verifyHmac','createSignature','verifySignature','revealSpecificKeyLinkage'];
  const bm = ['listOutputs','relinquishOutput'];
  const cm = ['listCertificates','acquireCertificate','proveCertificate','relinquishCertificate'];
  const seen = { protocol: new Set(), basket: new Set(), cert: new Set() };
  const of = window.fetch;
  
  // Default descriptions for common protocols
  const protocolDescriptions = {
    'auth message signature': 'For mutual authentication with servers',
    'server hmac': 'For nonce generation and HMAC creation',
    'messagebox': 'For message delivery and communication',
    '3241645161d8': 'For payment transactions',
    'identity key retrieval': 'For identity resolution and verification',
    'certificate list': 'For certificate registry access',
    'contact': 'For contact management and encryption',
    'wallet settings': 'For wallet configuration and preferences',
    'PushDrop': 'For token transactions'
  };
  
  function getDescription(protocolName, method) {
    return protocolDescriptions[protocolName] || (method + ' using "' + protocolName + '"');
  }
  
  function send(type, permission) {
    fetch(COLLECTOR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, permission })
    }).catch(() => {});
  }
  
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input.url || input.href || '');
    
    if (url.includes('localhost:3321') || url.includes('127.0.0.1:3321')) {
      const method = new URL(url).pathname.slice(1);
      let args = {};
      try { if (init?.body) args = JSON.parse(init.body); } catch {}
      
      console.log('%c→ ' + method, 'color: cyan');
      
      // Protocol permissions
      if (pm.includes(method) && args.protocolID) {
        const [sec, name] = args.protocolID;
        const cp = args.counterparty || 'self';
        const key = sec + ':' + name + ':' + cp;
        if (!seen.protocol.has(key)) {
          seen.protocol.add(key);
          const desc = getDescription(name, method);
          send('protocol', { protocolID: [sec, name], counterparty: cp, description: desc });
          console.log('%c✓ Protocol: [' + sec + ', "' + name + '"] → ' + cp, 'color: green');
        }
      }
      
      // Basket access
      if (bm.includes(method) && args.basket && !seen.basket.has(args.basket)) {
        seen.basket.add(args.basket);
        send('basket', { basket: args.basket, description: 'Access to "' + args.basket + '"' });
        console.log('%c✓ Basket: "' + args.basket + '"', 'color: green');
      }
      
      // Certificate access
      if (cm.includes(method)) {
        const type = args.type || (args.types && args.types[0]);
        if (type && !seen.cert.has(type)) {
          seen.cert.add(type);
          send('certificate', { type, certifier: args.certifier, description: method + ' for "' + type + '"' });
          console.log('%c✓ Certificate: "' + type + '"', 'color: green');
        }
      }
    }
    
    return of.call(window, input, init);
  };
  
  console.log('%c🔍 Permission Monitor Active', 'color: yellow; font-weight: bold');
})();
</script>
`
}
