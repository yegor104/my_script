// buy.ts
import 'dotenv/config'
import bs58 from 'bs58'
import BN from 'bn.js'
import {
  Connection, Keypair, PublicKey, VersionedTransaction,
} from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import {
  Raydium, PoolFetchType, TxVersion, CurveCalculator,
} from '@raydium-io/raydium-sdk-v2'

function need(k: string) { const v = process.env[k]; if (!v) throw new Error(`Missing env ${k}`); return v }
const RPC_URL         = need('RPC_URL')
const WALLET_SECRET   = need('WALLET_SECRET') // bs58
const TARGET_MINT_STR = need('TARGET_MINT')
const AMOUNT_IN_SOL   = parseFloat(need('AMOUNT_IN_SOL'))
const SLIPPAGE_BPS    = parseInt(process.env.SLIPPAGE_BPS || '300', 10)
const HINT_POOL_ID    = process.env.POOL_ID ? new PublicKey(process.env.POOL_ID) : null

async function main() {
  const connection = new Connection(RPC_URL, { commitment: 'confirmed' })
  const owner = Keypair.fromSecretKey(bs58.decode(WALLET_SECRET))
  const raydium = await Raydium.load({ connection, owner, blockhashCommitment: 'finalized' })

  const wsolMintStr = NATIVE_MINT.toBase58()
  const targetMint = new PublicKey(TARGET_MINT_STR)

  type Picked = { kind: 'cpmm' | 'amm', id: PublicKey }
  let picked: Picked | null = null

  if (HINT_POOL_ID) {
    const acc = await connection.getAccountInfo(HINT_POOL_ID)
    if (!acc) throw new Error(`Pool not found: ${HINT_POOL_ID.toBase58()}`)
    const CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
    const AMM_V4       = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
    picked = acc.owner.equals(CPMM_PROGRAM) ? { kind: 'cpmm', id: HINT_POOL_ID }
          : acc.owner.equals(AMM_V4)       ? { kind: 'amm',  id: HINT_POOL_ID }
          : null
    if (!picked) throw new Error('Unknown pool program id')
  } else {
    const list = await raydium.api.fetchPoolByMints({
      mint1: targetMint.toBase58(),
      mint2: wsolMintStr,
      type: PoolFetchType.All,
      sort: 'liquidity',
      order: 'desc',
      page: 1,
    })
    const cpmm = list.data?.find(p => p.programId === 'CPMM')
    const amm  = list.data?.find(p => p.programId === 'AMM')
    if (cpmm) picked = { kind: 'cpmm', id: new PublicKey(cpmm.id) }
    else if (amm) picked = { kind: 'amm', id: new PublicKey(amm.id) }
    else throw new Error('No Raydium pool (CPMM/AMM) for TARGET_MINT × SOL')
  }

  console.log('Wallet :', owner.publicKey.toBase58())
  console.log('Token  :', targetMint.toBase58())
  console.log('Pool   :', picked!.id.toBase58(), `(${picked!.kind.toUpperCase()})`)

  const amountInLamports = new BN(Math.floor(AMOUNT_IN_SOL * 1e9).toString())
  const computeBudgetConfig = { units: 600_000, microLamports: 1_000_000 } // опционально

  // ===== CPMM =====
  if (picked!.kind === 'cpmm') {
    const { poolInfo, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(picked!.id.toBase58())
    const baseIn = poolInfo.mintA.address === wsolMintStr

    const inReserve  = baseIn ? rpcData.baseReserve : rpcData.quoteReserve
    const outReserve = baseIn ? rpcData.quoteReserve : rpcData.baseReserve
    const swapResult = CurveCalculator.swap(amountInLamports, inReserve, outReserve, rpcData.configInfo.tradeFeeRate)

    const { transaction } = await raydium.cpmm.swap({
      poolInfo,
      baseIn,
      inputAmount: amountInLamports,
      swapResult,
      txVersion: TxVersion.V0,
      computeBudgetConfig,
      config: {
        associatedOnly: false,          // допустимо в 0.2.8-alpha
        checkCreateATAOwner: true,       // платим SOL -> wSOL
        bypassAssociatedCheck: false,
      },
    })

    const vtx = transaction as VersionedTransaction
    vtx.sign([owner])
    const sig = await connection.sendTransaction(vtx, { maxRetries: 20 })
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    console.log('✅ Swap (CPMM): https://solscan.io/tx/' + sig)
    return
  }

  // ===== AMM v4 =====
  {
    // В этой версии у ответа поле называется poolRpcData
    const { poolInfo, poolRpcData } =
      await raydium.liquidity.getPoolInfoFromRpc({ poolId: picked!.id.toBase58() })

    const baseIn = poolInfo.mintA.address === wsolMintStr
    const mintIn  = baseIn ? poolInfo.mintA.address : poolInfo.mintB.address
    const mintOut = baseIn ? poolInfo.mintB.address : poolInfo.mintA.address

    // считаем minAmountOut через computeAmountOut
    const out = raydium.liquidity.computeAmountOut({
      poolInfo: {
        ...poolInfo,
        baseReserve:  poolRpcData.baseReserve,
        quoteReserve: poolRpcData.quoteReserve,
        status:       poolRpcData.status.toNumber(),
        version: 4,
      },
      amountIn: amountInLamports,
      mintIn,
      mintOut,
      slippage: SLIPPAGE_BPS / 10_000,
    })

    const { transaction } = await raydium.liquidity.swap({
      poolInfo,
      amountIn: amountInLamports,
      amountOut: out.minAmountOut,   // вместо slippage
      fixedSide: 'in',
      inputMint: wsolMintStr,        // string
      txVersion: TxVersion.V0,
      computeBudgetConfig,
      config: {
        associatedOnly: false,       // допустимо
        inputUseSolBalance: true,
        outputUseSolBalance: false,
      },
    })

    const vtx = transaction as VersionedTransaction
    vtx.sign([owner])
    const sig = await connection.sendTransaction(vtx, { maxRetries: 20 })
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    console.log('✅ Swap (AMM v4): https://solscan.io/tx/' + sig)
  }
}

main().catch((e) => { console.error('❌ Error:', e); process.exit(1) })
