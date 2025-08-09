// @ts-nocheck
import 'dotenv/config'
import bs58 from 'bs58'
import BN from 'bn.js'
import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram,
  Transaction, SystemProgram, LAMPORTS_PER_SOL
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, AccountLayout,
  createInitializeAccountInstruction, createCloseAccountInstruction, getMint
} from '@solana/spl-token'

// ===== Raydium low-level (src/*)
import {
  getPdaLaunchpadPoolId,
  getPdaPlatformVault,
  getPdaCreatorVault,
  getPdaLaunchpadAuth,
} from '@raydium-io/raydium-sdk-v2/src/raydium/launchpad/pda'
import { buyExactOutInstruction } from '@raydium-io/raydium-sdk-v2/src/raydium/launchpad/instrument'
import { LaunchpadPool } from '@raydium-io/raydium-sdk-v2/src/raydium/launchpad/layout'

// ===== LaunchLab mainnet
const LAUNCHPAD_PROGRAM = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj')

/* ========= ENV ========= */
function need(k: string) { const v = process.env[k]; if (!v) throw new Error(`Missing env ${k}`); return v }

const RPC_URL               = need('RPC_URL')
const JITO_URLS             = (process.env.JITO_URLS || [
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
].join(',')).split(',').map(s => s.trim())

const JITO_SECRET           = need('JITO_SECRET')  // x-jito-auth

const SNIPER1_SECRET_KEY    = need('SNIPER1_SECRET_KEY')  // base58
const SNIPER2_SECRET_KEY    = need('SNIPER2_SECRET_KEY')  // base58
const MINT_STR              = need('MINT')

const AMOUNT_OUT_UI         = parseFloat(need('AMOUNT_OUT_UI'))
const MAX_SOL               = parseFloat(need('MAX_SOL'))
const SLIPPAGE_BPS          = parseInt(need('SLIPPAGE_BPS'), 10) // оставлен для совместимости

const CU_LIMIT              = parseInt(process.env.CU_LIMIT || '600000', 10)
const BUY_CU_PRICE_MICRO    = BigInt(process.env.BUY_CU_PRICE_MICRO || '0')

const SHARE_FEE_BPS         = new BN(process.env.SHARE_FEE_BPS ?? '0')
const SHARE_FEE_RECEIVER    = process.env.SHARE_FEE_RECEIVER ? new PublicKey(process.env.SHARE_FEE_RECEIVER) : undefined

const TIP_LAMPORTS          = BigInt(process.env.TIP_LAMPORTS || `${Math.floor(0.002 * LAMPORTS_PER_SOL)}`)
const TIP_ACCOUNT_OVERRIDE  = process.env.TIP_ACCOUNT_OVERRIDE || ''

const BUNDLE_RETRIES        = parseInt(process.env.BUNDLE_RETRIES || '6', 10)
const POLL_TIMEOUT_S        = parseInt(process.env.POLL_TIMEOUT_S || '12', 10)

const JITO_MIN_INTERVAL_MS  = parseInt(process.env.JITO_MIN_INTERVAL_MS || '800', 10)
const POLL_INTERVAL_MS      = Math.max(JITO_MIN_INTERVAL_MS, parseInt(process.env.POLL_INTERVAL_MS || '900', 10))

// fallback tip-аккаунты (mainnet)
const TIP_ACCOUNTS_FALLBACK = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
]

/* ========= State ========= */
const connection = new Connection(RPC_URL, { commitment: 'confirmed' })
const sniper1 = Keypair.fromSecretKey(bs58.decode(SNIPER1_SECRET_KEY))
const sniper2 = Keypair.fromSecretKey(bs58.decode(SNIPER2_SECRET_KEY))
const mintA = new PublicKey(MINT_STR)
const mintB = NATIVE_MINT

let lastJitoCallAt = 0

/* ========= Utils ========= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function throttleJito() {
  const now = Date.now()
  const wait = lastJitoCallAt + JITO_MIN_INTERVAL_MS - now
  if (wait > 0) await sleep(wait)
  lastJitoCallAt = Date.now()
}
function b64(tx: Transaction) { return Buffer.from(tx.serialize()).toString('base64') }

/* ========= Мини-клиент Jito JSON-RPC (правильный путь + лог ошибок) ========= */
async function jitoCall(baseUrl: string, method: string, params: any[]) {
  const url = `${baseUrl.replace(/\/+$/,'')}/api/v1/bundles`
  const headers: Record<string,string> = {
    'content-type': 'application/json',
    'x-jito-auth': JITO_SECRET,
  }

  let attempt = 0
  let delay = 600 // стартовый backoff поверх общего троттлинга
  while (true) {
    await throttleJito()

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

    if (res.status === 429) {
      attempt++
      if (attempt > 3) throw new Error(`Jito ${method} HTTP 429 (max backoff reached)`)
      const jitter = 150 + Math.floor(Math.random() * 250) // 150–400ms
      const wait = delay + jitter
      console.log(`[${method}] 429 → backoff ${wait}ms (attempt ${attempt})`)
      await sleep(wait)
      delay = Math.min(Math.floor(delay * 1.7), 3000) // растём до ~3s
      continue
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Jito ${method} HTTP ${res.status} ${txt ? `— ${txt}` : ''}`)
    }

    const j = await res.json()
    if (j.error) throw new Error(`Jito ${method} error: ${JSON.stringify(j.error)}`)
    return j.result
  }
}

// Фоллбэк-обёртки над sendBundle / getBundleStatuses
const jitoSendBundle = async (base: string, txsB64: string[]) => {
  try {
    // Попытка №1 — «чистые» параметры (официальный формат)
    return await jitoCall(base, 'sendBundle', [[...txsB64]])
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg.includes('400') || msg.toLowerCase().includes('invalid') || msg.includes('params')) {
      console.log('sendBundle fallback → with encoding param')
      return await jitoCall(base, 'sendBundle', [[...txsB64], 'base64'])
      // при желании можно добавить ещё один фоллбэк:
      // return await jitoCall(base, 'sendBundle', [[...txsB64], { encoding: 'base64' }])
    }
    throw e
  }
}
const jitoGetBundleStatuses = (base: string, ids: string[]) =>
  jitoCall(base, 'getBundleStatuses', [ids])

/* ========= Tip account selection ========= */
async function getTipAccountSmart(): Promise<string> {
  if (TIP_ACCOUNT_OVERRIDE) return TIP_ACCOUNT_OVERRIDE
  return TIP_ACCOUNTS_FALLBACK[Math.floor(Math.random() * TIP_ACCOUNTS_FALLBACK.length)]
}

/* ========= Builders ========= */
async function ensureAtaIx(owner: PublicKey, mint: PublicKey, payer: PublicKey) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID)
  try { await getAccount(connection, ata); return { ata, ix: null as any } }
  catch { return { ata, ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint, TOKEN_PROGRAM_ID) } }
}
async function createTempWSOLAccountIx(payer: Keypair, amountLamports: number) {
  const wsolAcc = Keypair.generate()
  const rent = await connection.getMinimumBalanceForRentExemption(AccountLayout.span)
  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: wsolAcc.publicKey,
      lamports: rent + amountLamports,
      space: AccountLayout.span,
      programId: TOKEN_PROGRAM_ID
    }),
    createInitializeAccountInstruction(wsolAcc.publicKey, NATIVE_MINT, payer.publicKey)
  ]
  return { wsolAcc, ixs }
}
async function buildBuyTx(ownerKp: Keypair, common: any) {
  const { poolId, poolInfo, outAmount, maxInLamports, mintAProgram, platformVault, creatorVault } = common
  const { ata: userTokenA, ix: createAtaIx } = await ensureAtaIx(ownerKp.publicKey, mintA, ownerKp.publicKey)
  const { wsolAcc, ixs: wsolInitIxs } = await createTempWSOLAccountIx(ownerKp, Number(maxInLamports))
  const ixBuy = buyExactOutInstruction(
    LAUNCHPAD_PROGRAM, ownerKp.publicKey, getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,
    poolInfo.configId, poolInfo.platformId, poolId,
    userTokenA, wsolAcc.publicKey,
    poolInfo.vaultA, poolInfo.vaultB,
    mintA, NATIVE_MINT,
    mintAProgram, TOKEN_PROGRAM_ID,
    platformVault, creatorVault,
    outAmount, maxInLamports, SHARE_FEE_BPS, SHARE_FEE_RECEIVER
  )
  const ixClose = createCloseAccountInstruction(wsolAcc.publicKey, ownerKp.publicKey, ownerKp.publicKey)
  const cuIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BUY_CU_PRICE_MICRO }),
  ]
  const tx = new Transaction()
  tx.add(...cuIxs); if (createAtaIx) tx.add(createAtaIx); tx.add(...wsolInitIxs); tx.add(ixBuy); tx.add(ixClose)
  tx.feePayer = ownerKp.publicKey
  return { tx, signers: [ownerKp, wsolAcc] }
}
async function buildBuyTxWithTip(ownerKp: Keypair, common: any, tipAccount: string, tipLamports: bigint) {
  const { poolId, poolInfo, outAmount, maxInLamports, mintAProgram, platformVault, creatorVault } = common
  const { ata: userTokenA, ix: createAtaIx } = await ensureAtaIx(ownerKp.publicKey, mintA, ownerKp.publicKey)
  const { wsolAcc, ixs: wsolInitIxs } = await createTempWSOLAccountIx(ownerKp, Number(maxInLamports))
  const ixBuy = buyExactOutInstruction(
    LAUNCHPAD_PROGRAM, ownerKp.publicKey, getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,
    poolInfo.configId, poolInfo.platformId, poolId,
    userTokenA, wsolAcc.publicKey,
    poolInfo.vaultA, poolInfo.vaultB,
    mintA, NATIVE_MINT,
    mintAProgram, TOKEN_PROGRAM_ID,
    platformVault, creatorVault,
    outAmount, maxInLamports, SHARE_FEE_BPS, SHARE_FEE_RECEIVER
  )
  const tipIx = SystemProgram.transfer({
    fromPubkey: ownerKp.publicKey,
    toPubkey: new PublicKey(tipAccount),
    lamports: Number(tipLamports),
  })
  const ixClose = createCloseAccountInstruction(wsolAcc.publicKey, ownerKp.publicKey, ownerKp.publicKey)
  const cuIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BUY_CU_PRICE_MICRO }),
  ]
  const tx = new Transaction()
  tx.add(...cuIxs); if (createAtaIx) tx.add(createAtaIx); tx.add(...wsolInitIxs); tx.add(ixBuy); tx.add(tipIx); tx.add(ixClose)
  tx.feePayer = ownerKp.publicKey
  return { tx, signers: [ownerKp, wsolAcc] }
}

/* ========= Main ========= */
async function main() {
  console.log('--- LAUNCHLAB DOUBLE BUY (Jito bundle; TIP inside 2nd tx; x-jito-auth + fallback) ---')
  console.log('RPC      :', RPC_URL)
  console.log('JITO URLs:', JITO_URLS.join(' | '))
  console.log('MINT     :', mintA.toBase58())
  console.log('SNIPER1  :', sniper1.publicKey.toBase58())
  console.log('SNIPER2  :', sniper2.publicKey.toBase58())

  // Pool & mint meta
  const poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, NATIVE_MINT).publicKey
  const poolAcc = await connection.getAccountInfo(poolId, { commitment: 'processed' })
  if (!poolAcc) throw new Error('LaunchLab pool not found: ' + poolId.toBase58())
  const poolInfo = LaunchpadPool.decode(poolAcc.data)

  const mintInfo = await getMint(connection, mintA)
  const decimals = mintInfo.decimals
  const outAmount = new BN(Math.floor(AMOUNT_OUT_UI * 10 ** decimals).toString())
  const maxInLamports = new BN(Math.floor(MAX_SOL * LAMPORTS_PER_SOL).toString())
  const mintAAccountInfo = await connection.getAccountInfo(mintA)
  const mintAProgram = mintAAccountInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const platformVault = getPdaPlatformVault(LAUNCHPAD_PROGRAM, poolInfo.platformId, NATIVE_MINT).publicKey
  const creatorVault  = getPdaCreatorVault(LAUNCHPAD_PROGRAM, poolInfo.creator,    NATIVE_MINT).publicKey

  const common = { poolId, poolInfo, outAmount, maxInLamports, mintAProgram, platformVault, creatorVault }

  // Tip аккаунт
  const tipAcc = await getTipAccountSmart()
  console.log('Tip account:', tipAcc, 'amount:', TIP_LAMPORTS.toString())

  // Две транзакции
  const buy1 = await buildBuyTx(sniper1, common)
  const buy2 = await buildBuyTxWithTip(sniper2, common, tipAcc, TIP_LAMPORTS)

  let attempt = 0
  while (attempt < BUNDLE_RETRIES) {
    // ротация региона на каждую попытку
    const baseUrl = JITO_URLS[attempt % JITO_URLS.length]

    // новый blockhash + подписи на каждую попытку
    const { blockhash } = await connection.getLatestBlockhash('processed')
    for (const { tx } of [buy1, buy2]) tx.recentBlockhash = blockhash
    buy1.tx.partialSign(...buy1.signers)
    buy2.tx.partialSign(...buy2.signers)

    const bundleTxsB64 = [b64(buy1.tx), b64(buy2.tx)]
    console.log(`[try ${attempt + 1}/${BUNDLE_RETRIES}] sendBundle → ${baseUrl}`)

    try {
      const bundleId = await jitoSendBundle(baseUrl, bundleTxsB64)
      console.log('bundle_id:', bundleId)

      // пуллинг статуса
      const t0 = Date.now()
      while (Date.now() - t0 < POLL_TIMEOUT_S * 1000) {
        const statusArr = await jitoGetBundleStatuses(baseUrl, [bundleId])
        const status = Array.isArray(statusArr) ? statusArr[0] : statusArr
        const conf = status?.confirmation_status || status?.status || ''
        if (conf === 'confirmed' || conf === 'finalized' || status?.landed) {
          console.log('✅ Bundle landed:', JSON.stringify(status))
          return
        }
        if (status?.error || status?.err) {
          console.log('❌ Bundle error:', JSON.stringify(status.error || status.err))
          break
        }
        await sleep(POLL_INTERVAL_MS)
      }
      console.log('⏳ Not landed — retry…')
    } catch (e: any) {
      console.log('sendBundle error:', e?.message || e)
    }

    attempt++
  }

  console.log('❌ Failed to land bundle after retries.')
}

main().catch((e) => { console.error('❌ Top-level error:', e); process.exit(1) })
