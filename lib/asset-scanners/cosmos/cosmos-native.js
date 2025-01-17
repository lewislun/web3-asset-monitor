import { QueryClient, setupDistributionExtension } from '@cosmjs/stargate'
import { chains, assets as assetLists } from 'chain-registry'

import * as enums from '../../enums.js'
import * as types from '../../types.js'
import { parseDecimal, humanize, createLogger } from '../../utils/index.js'
import BaseCosmosAssetScanner from './base.js'
import { AssetQuery, AssetSnapshot, AssetInfo } from '../../models/index.js'

/**
 * @typedef {import('@cosmjs/stargate').DistributionExtension} DistributionExtension
 * @typedef {QueryClient & DistributionExtension} CustomizedQueryClient
 */

const logger = createLogger('CosmosNativeTokenScanner')

export default class CosmosNativeTokenScanner extends BaseCosmosAssetScanner {

	/** @type {string} */								denom
	/** @type {number} */								decimals
	/** @protected @type {CustomizedQueryClient} */		queryClient
	/** @protected @type {AssetInfo} */					nativeAssetInfo

	/**
	 * @protected
	 */
	async _init() {
		await super._init()
		this.queryClient = QueryClient.withExtensions(this.tmClient, setupDistributionExtension)

		// Get native asset info
		this.nativeAssetInfo = await AssetInfo.getNativeToken(this.chain)

		// Get chain from registry
		const chainId = await this.rateLimiter.exec(() => this.cwClient.getChainId())
		const chain = chains.find(chain => chain.chain_id === chainId)
		if (!chain) throw new Error(`This chain is not in chain-registry - chainId: ${chainId}`)
		const assetList = assetLists.find(list => list.chain_name === chain.chain_name)
		if (!assetList) throw new Error(`AssetList for this chain is not found in registry - chainId: ${chainId}`)

		// Get denom
		this.denom = chain?.fees?.fee_tokens[0]?.denom
		if (chain?.fees?.fee_tokens[0]?.length > 1) logger.warn(`This chain has more than 1 fee tokens - chainId: ${chainId}`)
		if (!this.denom) {
			logger.debug('Unable to get base denom from chain info, proceeding to get denom from assetList by coingecko id...')
			this.denom = await this.getDenomThruCoinGeckoByCode(assetList, this.nativeAssetInfo.code)
		}
		if (!this.denom) throw new Error(`Error getting denom of native token - chainId: ${chainId}`)
		
		// Get decimals
		this.decimals = this.getDecimalsByDenom(assetList, this.denom)
		if (this.decimals === undefined) throw new Error(`Error getting native token's decimals - chainId: ${chainId}, denom: ${this.denom}`)
	}

	/**
	 * Since the registry's assetList includes coingecko id, we can use the native asset code to find the coingecko id from CoinGeckoPriceScanner, than use the coingecko id to search for the denom in AssetList.
	 * @param {typeof assetLists[0]} assetList
	 * @param {types.AssetCode} code
	 * @returns {Promise<string | undefined>}
	 */
	async getDenomThruCoinGeckoByCode(assetList, code) {
		/** @type {import('../../price-scanners/coin-gecko').default} */
		const coinGeckoScanner = this.priceAggregator.getScanner(enums.PriceScannerType.COIN_GECKO)
		if (!coinGeckoScanner) {
			logger.debug('CoinGeckoPriceScanner not found.')
			return undefined
		}
		const coinGeckoId = await coinGeckoScanner.getScannerSpecificAssetCode(code)
		if (!coinGeckoId) {
			logger.debug(`AssetCode not found in CoinGecko assets - code: ${code}`)
			return undefined
		}

		return assetList.assets.find(asset => asset.coingecko_id === coinGeckoId)?.base
	}

	/**
	 * @protected
	 * @param {typeof assetLists[0]} assetList
	 * @param {string} denom
	 * @returns {number | undefined}
	 */
	getDecimalsByDenom(assetList, denom) {
		const asset = assetList.assets.find(asset => asset.base === denom)
		if (!asset) {
			logger.debug(`Denom not found in AssetList - denom: ${denom}`)
			return undefined
		}
		return asset.denom_units.find(unit => unit.denom === asset.display)?.exponent
	}

	/**
	 * @protected
	 * @param {AssetQuery} query
	 * @returns {Promise<AssetSnapshot[]>}
	 */
	async _query(query) {
		const [ price, block, coin, stakedCoin, stakingRewardResult ] = await Promise.all([
			this.priceAggregator.getPrice(this.nativeAssetInfo.code),
			this.rateLimiter.exec(() => this.client.getBlock()),
			this.rateLimiter.exec(() => this.client.getBalance(query.addr, this.denom)),
			this.rateLimiter.exec(() => this.client.getBalanceStaked(query.addr)),
			this.rateLimiter.exec(() => this.queryClient.distribution.delegationTotalRewards(query.addr)),
		])

		/** @type {AssetSnapshot} */
		const results = []
		const capturedAt = new Date(block.header.time)

		// Liquid tokens
		const balance = parseDecimal(coin.amount, this.decimals)
		if (balance.cmp(0) != 0) {
			results.push(AssetSnapshot.fromJson({
				name: `${humanize(this.chain)} Native Token`,
				code: this.nativeAssetInfo.code,
				chain: this.chain,
				type: enums.AssetType.NATIVE_TOKEN,
				state: enums.AssetState.LIQUID,
				quantity: balance,
				usd_value: balance.mul(price),
				usd_value_per_quantity: price,
				captured_at: capturedAt,
			}))
		}

		// Staked tokens
		if (stakedCoin && stakedCoin.amount != '0') {
			const balance = parseDecimal(stakedCoin.amount, this.decimals)
			results.push(AssetSnapshot.fromJson({
				name: `Staked ${humanize(this.chain)} Native Token`,
				code: this.nativeAssetInfo.code,
				chain: this.chain,
				type: enums.AssetType.NATIVE_TOKEN,
				state: enums.AssetState.LOCKED,
				quantity: balance,
				usd_value: balance.mul(price),
				usd_value_per_quantity: price,
				captured_at: capturedAt,
			}))
		}

		// Staking rewards
		if (stakingRewardResult) {
			const coin = stakingRewardResult.total.find(c => c.denom === this.denom)
			const rewardDecimals = this.decimals + 18
			if (coin && coin.amount !== '0') {
				const balance = parseDecimal(coin.amount, rewardDecimals)
				results.push(AssetSnapshot.fromJson({
					name: `${humanize(this.chain)} Staking Reward`,
					code: this.nativeAssetInfo.code,
					chain: this.chain,
					type: enums.AssetType.NATIVE_TOKEN,
					state: enums.AssetState.CLAIMABLE,
					quantity: balance,
					usd_value: balance.mul(price),
					usd_value_per_quantity: price,
					captured_at: capturedAt,
				}))
			}
		}

		// TODO: unbonding

		return results
	}
}