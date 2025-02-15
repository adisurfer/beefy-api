import BigNumber from 'bignumber.js';
import { multicallAddress, web3Factory } from './web3';
import { MultiCall } from 'eth-multicall';
import { getContract } from './contractHelper';
import DMMPool from '../abis/DMMPool.json';
import ERC20 from '../abis/common/ERC20/ERC20.json';
import { ChainId } from '../../packages/address-book/address-book';

const DEBUG_ORACLES = [];

const sortByKeys = o => {
  return Object.keys(o)
    .sort()
    .reduce((r, k) => ((r[k] = o[k]), r), {});
};

const calcTokenPrice = (knownPrice, knownToken, unknownToken) => {
  const valuation = knownToken.virtualBal.dividedBy(knownToken.decimals).multipliedBy(knownPrice);
  const price = valuation.multipliedBy(unknownToken.decimals).dividedBy(unknownToken.virtualBal);

  return {
    price: price.toNumber(),
    weight: unknownToken.virtualBal.dividedBy(unknownToken.decimals).toNumber(),
  };
};

const calcLpPrice = (pool, tokenPrices) => {
  const lp0 = pool.lp0.balance
    .multipliedBy(tokenPrices[pool.lp0.oracleId])
    .dividedBy(pool.lp0.decimals);
  const lp1 = pool.lp1.balance
    .multipliedBy(tokenPrices[pool.lp1.oracleId])
    .dividedBy(pool.lp1.decimals);
  const price = lp0.plus(lp1).multipliedBy(pool.decimals).dividedBy(pool.totalSupply).toNumber();

  return {
    price,
    tokens: [pool.lp0.address, pool.lp1.address],
    balances: [
      pool.lp0.balance.dividedBy(pool.lp0.decimals).toString(10),
      pool.lp1.balance.dividedBy(pool.lp1.decimals).toString(10),
    ],
    totalSupply: pool.totalSupply.dividedBy(pool.decimals).toString(10),
  };
};

export type DmmPrices = {
  poolPrices: Record<string, number>;
  tokenPrices: Record<string, number>;
  lpsBreakdown: Record<
    string,
    {
      price: number;
      tokens: string[];
      balances: string[];
      totalSupply: string;
    }
  >;
};

export async function fetchDmmPrices(
  pools: any[],
  knownPrices: Record<string, number>
): Promise<DmmPrices> {
  let prices = { ...knownPrices };
  let lps = {};
  let breakdown = {};
  let weights = {};
  Object.keys(knownPrices).forEach(known => {
    weights[known] = Number.MAX_SAFE_INTEGER;
  });

  const chainIds: ChainId[] = pools.map(p => p.chainId);
  const uniqueChainIds = [...new Set(chainIds)];

  for (let i = 0; i < uniqueChainIds.length; i++) {
    const web3 = web3Factory(uniqueChainIds[i]);
    let filtered = pools.filter(p => p.chainId == uniqueChainIds[i]);
    const multicall = new MultiCall(web3, multicallAddress(uniqueChainIds[i]));

    const dmmCalls = [];
    const lp0Calls = [];
    const lp1Calls = [];
    filtered.forEach(pool => {
      const tokenContract = getContract(DMMPool, pool.address);
      const lp0Contract = getContract(ERC20, pool.lp0.address);
      const lp1Contract = getContract(ERC20, pool.lp1.address);
      dmmCalls.push({
        totalSupply: tokenContract.methods.totalSupply(),
        tradeInfo: tokenContract.methods.getTradeInfo(),
      });
      lp0Calls.push({
        balance: lp0Contract.methods.balanceOf(pool.address),
      });
      lp1Calls.push({
        balance: lp1Contract.methods.balanceOf(pool.address),
      });
    });

    let res;
    try {
      res = await multicall.all([dmmCalls, lp0Calls, lp1Calls]);
    } catch (e) {
      console.error('fetchDmmPrices', e);
      continue;
    }

    const totalSupply = res[0].map(v => new BigNumber(v.totalSupply));
    const virtualBal0 = res[0].map(v => new BigNumber(v.tradeInfo['2']));
    const virtualBal1 = res[0].map(v => new BigNumber(v.tradeInfo['3']));
    const lp0Bal = res[1].map(v => new BigNumber(v.balance));
    const lp1Bal = res[2].map(v => new BigNumber(v.balance));

    for (let i = 0; i < filtered.length; i++) {
      filtered[i].totalSupply = totalSupply[i];
      filtered[i].lp0.virtualBal = virtualBal0[i];
      filtered[i].lp1.virtualBal = virtualBal1[i];
      filtered[i].lp0.balance = lp0Bal[i];
      filtered[i].lp1.balance = lp1Bal[i];
    }

    const unsolved = filtered.slice();
    let solving = true;
    while (solving) {
      solving = false;

      for (let i = unsolved.length - 1; i >= 0; i--) {
        const pool = unsolved[i];
        const trySolve = [];

        if (pool.lp0.oracleId in weights && pool.lp1.oracleId in weights) {
          trySolve.push({ knownToken: pool.lp0, unknownToken: pool.lp1 });
          trySolve.push({ knownToken: pool.lp1, unknownToken: pool.lp0 });
        } else if (pool.lp0.oracleId in prices) {
          trySolve.push({ knownToken: pool.lp0, unknownToken: pool.lp1 });
        } else if (pool.lp1.oracleId in prices) {
          trySolve.push({ knownToken: pool.lp1, unknownToken: pool.lp0 });
        } else {
          // both unknown: not solved yet but could be solved later
          continue;
        }

        for (const { knownToken, unknownToken } of trySolve) {
          const { price, weight } = calcTokenPrice(
            prices[knownToken.oracleId],
            knownToken,
            unknownToken
          );
          const existingWeight = weights[unknownToken.oracleId] || 0;
          const betterPrice = weight > existingWeight;

          if (DEBUG_ORACLES.includes(unknownToken.oracleId)) {
            console.log(
              `${betterPrice ? 'Setting' : 'Skipping'} ${unknownToken.oracleId} to $${price} via ${
                knownToken.oracleId
              } ($${prices[knownToken.oracleId]}) in ${pool.name} (${
                pool.address
              }) - new weight ${weight} vs existing ${existingWeight}`
            );
          }

          if (betterPrice) {
            prices[unknownToken.oracleId] = price;
            weights[unknownToken.oracleId] = weight;
          }
        }

        unsolved.splice(i, 1);
        solving = true;
      }
    }

    if (unsolved.length > 0) {
      // actually not solved
      console.log('Unsolved pools: ');
      unsolved.forEach(pool => console.log(pool.lp0.oracleId, pool.lp1.oracleId, pool.name));
    }
  }

  for (const pool of pools) {
    const lpData = calcLpPrice(pool, prices);
    lps[pool.name] = lpData.price;
    breakdown[pool.name] = lpData;
  }

  return {
    poolPrices: sortByKeys(lps),
    tokenPrices: sortByKeys(prices),
    lpsBreakdown: sortByKeys(breakdown),
  };
}
