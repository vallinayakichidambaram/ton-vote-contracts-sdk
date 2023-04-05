import { getHttpEndpoint } from "@orbs-network/ton-access";
import { Address, TonClient, TonClient4 } from "ton";
import BigNumber from "bignumber.js";
import { CUSTODIAN_ADDRESSES } from "./custodian";
import _ from "lodash";
import { Transaction } from 'ton-core';
import { ProposalMetadata, ProposalResult, Votes, VotingPower } from "./interfaces";


export async function getClientV2(customEndpoint?: string, apiKey?: string): Promise<TonClient> {
  if (customEndpoint) {
    return new TonClient({ endpoint: customEndpoint, apiKey });
  }
  const endpoint = await getHttpEndpoint();
  return new TonClient({ endpoint });
}

export async function getClientV4(customEndpoint: string): Promise<TonClient4> {
  const endpoint = customEndpoint || "https://mainnet-v4.tonhubapi.com";
  return new TonClient4({ endpoint });
}

export async function getTransactions(
  client: TonClient,
  contractAddress: Address,
  toLt?: string
): Promise<{allTxns: Transaction[], maxLt: string}> {

  let maxLt = new BigNumber(toLt ?? -1);
  let startPage = { fromLt: "0", hash: "" };
  
  let allTxns: Transaction[] = [];
  let paging = startPage;
  console.log(toLt, paging);
  
  while (true) {
    console.log("Querying...");
    const txns = await client.getTransactions(contractAddress, {
      lt: paging.fromLt,
      to_lt: toLt,
      hash: paging.hash,
      limit: 500,
    });  

    console.log(`Got ${txns.length}, lt ${paging.fromLt}`);

    if (txns.length === 0) break;

    allTxns = [...allTxns, ...txns];

    // console.log("===========");
    // console.log(allTxns[0]);
    // console.log(allTxns[1]);
    // process.exit();
    
    // paging.fromLt = (txns[txns.length - 1].lt).toString();
    paging.fromLt = (txns[txns.length - 1].prevTransactionLt).toString();
    paging.hash = (txns[txns.length - 1].prevTransactionHash).toString(16);

    console.log(paging, 'new paging');
    
    // console.log((txns[txns.length - 1].prevTransactionLt).toString());
    // console.log(txns);
    console.log(txns[txns.length-1]);

    if (paging.fromLt === '0') break;

    
    txns.forEach((t) => {
      maxLt = BigNumber.max(new BigNumber(t.lt.toString()), maxLt);
    });
  }

  return { allTxns, maxLt: maxLt.toString() };
}

export function filterTxByTimestamp(transactions: Transaction[], lastLt: string) {
  const filteredTx = _.filter(transactions, function (transaction: Transaction) {
    return Number(transaction.lt) <= Number(lastLt);
  });

  return filteredTx;
}

export function getAllVotes(transactions: Transaction[], proposalInfo: ProposalMetadata): Votes {
  let allVotes: Votes = {};

  for (let i = transactions.length - 1; i >= 0; i--) {
    const txnBody = transactions[i]?.inMessage?.body;

    let vote = txnBody?.toString();
    if (!vote) continue;

    let tx = transactions[i]?.inMessage?.info.src;
    if (!tx) continue;
    let txSrc = tx.toString();

    if (
      transactions[i].now < proposalInfo.proposalStartTime ||
      transactions[i].now > proposalInfo.proposalEndTime || CUSTODIAN_ADDRESSES.includes(txSrc)
    )
      continue;

    vote = vote.toLowerCase();
    allVotes[txSrc] = {
      timestamp: transactions[i].now,
      vote: "",
      hash: transactions[i].prevTransactionHash.toString()
    };

    if (["y", "yes"].includes(vote)) {
      allVotes[txSrc].vote = "Yes";
    } else if (["n", "no"].includes(vote)) {
      allVotes[txSrc].vote = "No";
    } else if (["a", "abstain"].includes(vote)) {
      allVotes[txSrc].vote = "Abstain";
    }
  }

  return allVotes;
}

export async function getVotingPower(
  clientV4: TonClient4,
  proposalInfo: ProposalMetadata,
  transactions: Transaction[],
  votingPower: VotingPower = {}
): Promise<VotingPower> {
  let voters = Object.keys(getAllVotes(transactions, proposalInfo));

  let newVoters = [...new Set([...voters, ...Object.keys(votingPower)])];

  if (!newVoters) return votingPower;

  if (!proposalInfo.mcSnapshotBlock) return votingPower;

  for (const voter of newVoters) {
    votingPower[voter] = (
      await clientV4.getAccountLite(
        proposalInfo.mcSnapshotBlock,
        Address.parse(voter)
      )
    ).account.balance.coins;
  }

  return votingPower;
}

export async function getSingleVotingPower(
  clientV4: TonClient4,
  mcSnapshotBlock: number,
  address: Address
): Promise<string> {
    return (
      await clientV4.getAccountLite(
        mcSnapshotBlock,
        address
      )
    ).account.balance.coins;
}

export function calcProposalResult(votes: Votes, votingPower: VotingPower): ProposalResult {
  let sumVotes = {
    yes: new BigNumber(0),
    no: new BigNumber(0),
    abstain: new BigNumber(0),
  };

  for (const [voter, vote] of Object.entries(votes)) {
    if (!(voter in votingPower))
      throw new Error(`voter ${voter} not found in votingPower`);

      const _vote = vote.vote; 
    if (_vote === "Yes") {
      sumVotes.yes = new BigNumber(votingPower[voter]).plus(sumVotes.yes);
    } else if (_vote === "No") {
      sumVotes.no = new BigNumber(votingPower[voter]).plus(sumVotes.no);
    } else if (_vote === "Abstain") {
      sumVotes.abstain = new BigNumber(votingPower[voter]).plus(
        sumVotes.abstain
      );
    }
  }

  const totalWeights = sumVotes.yes.plus(sumVotes.no).plus(sumVotes.abstain);
  const yesPct = sumVotes.yes
    .div(totalWeights)
    .decimalPlaces(4)
    .multipliedBy(100)
    .toNumber();
  const noPct = sumVotes.no
    .div(totalWeights)
    .decimalPlaces(4)
    .multipliedBy(100)
    .toNumber();
  const abstainPct = sumVotes.abstain
    .div(totalWeights)
    .decimalPlaces(4)
    .multipliedBy(100)
    .toNumber();

    return {
    yes: yesPct,
    no: noPct,
    abstain: abstainPct,
    totalWeight: totalWeights.toString(),
  };
}

export function getCurrentResults(transactions: Transaction[], votingPower: VotingPower, proposalInfo: ProposalMetadata): ProposalResult {
  let votes = getAllVotes(transactions, proposalInfo);
  return calcProposalResult(votes, votingPower);
}


async function test() {
  let client = await getClientV2();
  console.log(client);
  const elector = Address.parse("Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF");
  const myWallet = Address.parse("EQDHz85Bey_jEhUvHYCgC3__f0qj5_QKNJMK4uvLCZTRxQE6");
  const votingContract = Address.parse("Ef-V3WPoPFeecWLT5vL41YIFrBFczkk-4sd3dhbJmO7McyEw");

  let x= await getTransactions(client, votingContract);
  console.log(x);
  
  
}


test().then(() => console.log('all done'));