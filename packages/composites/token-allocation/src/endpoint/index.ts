import { AdapterResponse, Execute, AdapterRequest, InputParameters } from '@chainlink/types'
import { DEFAULT_TOKEN_BALANCE, DEFAULT_TOKEN_DECIMALS, makeConfig, makeOptions } from '../config'
import { TokenAllocations, Config, ResponsePayload, GetPrices } from '../types'
import { Decimal } from 'decimal.js'
import { AdapterInputError, Requester, Validator } from '@chainlink/ea-bootstrap'
import { BigNumber } from 'ethers'
import { getPriceProvider } from '../dataProvider'

Decimal.set({ precision: 100 })

export const priceTotalValue = (
  source: string,
  allocations: TokenAllocations,
  quote: string,
  data: ResponsePayload,
): number => {
  return allocations
    .reduce((acc, t) => {
      const val = data[t.symbol].quote[quote].price
      if (!val)
        throw new Error(
          `ERROR: No price value found for ${t.symbol}/${quote} from the ${source} adapter.`,
        )
      const coins = new Decimal(t.balance.toString(10)).div(10 ** t.decimals)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return acc.add(coins.mul(val!))
    }, new Decimal(0))
    .toNumber()
}

export const marketCapTotalValue = (
  source: string,
  allocations: TokenAllocations,
  quote: string,
  data: ResponsePayload,
): number => {
  return allocations
    .reduce((acc, t) => {
      const val = data[t.symbol].quote[quote].marketCap
      if (!val)
        throw new Error(
          `ERROR: No marketcap value found for ${t.symbol}/${quote} from the ${source} adapter.`,
        )
      const coins = new Decimal(t.balance.toString(10)).div(10 ** t.decimals)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return acc.add(coins.mul(val!))
    }, new Decimal(0))
    .toNumber()
}

const toValidAllocations = (allocations: any[]): TokenAllocations => {
  const _toValidSymbol = (symbol: string) => {
    if (!symbol)
      throw new AdapterInputError({
        message: `Symbol not available for all tokens.`,
        statusCode: 400,
      })
    return symbol.toUpperCase()
  }
  const _toValidDecimals = (decimals: number | undefined) => {
    if (decimals === undefined) return DEFAULT_TOKEN_DECIMALS
    return Number.isInteger(decimals) && decimals >= 0 ? decimals : DEFAULT_TOKEN_DECIMALS
  }
  const _toValidBalance = (balance: number | string | undefined, decimals: number) => {
    if (!balance) return DEFAULT_TOKEN_BALANCE * 10 ** decimals
    let BNbalance
    try {
      BNbalance = BigNumber.from(balance.toString())
    } catch (e) {
      throw new AdapterInputError({ message: `Invalid balance: ${e.message}`, statusCode: 400 })
    }
    if (BNbalance.isNegative())
      throw new AdapterInputError({ message: `Balance cannot be negative`, statusCode: 400 })
    return balance
  }
  return allocations.map((t: any) => {
    const decimals = _toValidDecimals(t.decimals)
    return {
      symbol: _toValidSymbol(t.symbol),
      decimals,
      balance: _toValidBalance(t.balance, decimals),
    }
  })
}

const computePrice = async (
  source: string,
  getPrices: GetPrices,
  allocations: TokenAllocations,
  quote: string,
  additionalInput: Record<string, unknown>,
) => {
  const symbols = (allocations as TokenAllocations).map((t) => t.symbol)
  const payload = await getPrices(symbols, quote, additionalInput, false)
  const result = priceTotalValue(source, allocations, quote, payload)
  return { payload, result }
}

const computeMarketCap = async (
  source: string,
  getPrices: GetPrices,
  allocations: TokenAllocations,
  quote: string,
  additionalInput: Record<string, unknown>,
) => {
  const symbols = (allocations as TokenAllocations).map((t) => t.symbol)
  const payload = await getPrices(symbols, quote, additionalInput, true)

  const result = marketCapTotalValue(source, allocations, quote, payload)
  return { payload, result }
}

const inputParameters: InputParameters = {
  source: false,
  allocations: true,
  quote: false,
  method: false,
}

export const execute = async (input: AdapterRequest, config: Config): Promise<AdapterResponse> => {
  const paramOptions = makeOptions(config)
  const validator = new Validator(input, inputParameters, paramOptions)
  if (validator.error) throw validator.error

  const jobRunID = validator.validated.id
  const {
    quote = config.defaultQuote,
    method = config.defaultMethod,
    allocations,
    source = config.defaultSource || '',
    ...additionalInput
  } = validator.validated.data
  const startingAllocations = toValidAllocations(allocations)

  if (source === '') {
    throw Error('No source specified in the request or config!')
  }

  const sourceConfig = config.sources[source.toLowerCase()]

  const _success = (payload: ResponsePayload, result: number) =>
    Requester.success(
      jobRunID,
      {
        status: 200,
        data: { sources: [], payload, result },
      },
      true,
    )

  const getPrices = getPriceProvider(source.toLowerCase(), jobRunID, sourceConfig.api)
  switch (method.toLowerCase()) {
    case 'price': {
      const price = await computePrice(
        source.toLowerCase(),
        getPrices,
        startingAllocations,
        quote,
        additionalInput,
      )
      return _success(price.payload, price.result)
    }
    case 'marketcap': {
      const marketCap = await computeMarketCap(
        source.toLowerCase(),
        getPrices,
        startingAllocations,
        quote,
        additionalInput,
      )
      return _success(marketCap.payload, marketCap.result)
    }
    default:
      throw new AdapterInputError({
        jobRunID,
        message: `Method ${method} not supported.`,
        statusCode: 400,
      })
  }
}

export const makeExecute = (config?: Config): Execute => {
  return async (request: AdapterRequest) => execute(request, config || makeConfig())
}
