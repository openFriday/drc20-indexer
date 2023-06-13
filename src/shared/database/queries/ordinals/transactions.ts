import { IOutput } from "../../models/ordinals/Output";
import { ITransaction } from "../../models/ordinals/Transaction";
import { getRedisClient } from "../../../redis";

const dataKeys = {
  hash: "h",
  blockNumber: "bn",
  index: "i",
  inputs: "in",
  timestamp: "ts",
  output: "o",
  address: "a",
  transactionIndex: "ti",
  inscriptions: "ins",
  outputsFetched: "of",
  value: "v",
};

const unpackTransactionDataFromRedis = (transactionData: any) => {
  return {
    index: transactionData[dataKeys.index],
    timestamp: transactionData[dataKeys.timestamp],
    inputs: transactionData[dataKeys.inputs],
    outputsFetched: transactionData[dataKeys.outputsFetched],
  };
};

const unpackOutputDataFromRedis = (outputData: any) => {
  return {
    index: outputData[dataKeys.index],
    address: outputData[dataKeys.address],
    blockNumber: outputData[dataKeys.blockNumber],
    transactionIndex: outputData[dataKeys.transactionIndex],
    inscriptions: outputData[dataKeys.inscriptions] || [],
    value: outputData[dataKeys.value],
  };
};

export async function upsertTransactions(transactions: ITransaction[]) {
  const redisClient = await getRedisClient();

  // Iterate over the transactions
  for (const transaction of transactions) {
    const block = String(transaction.blockNumber);
    const txId = transaction.hash;

    // we don't save the txId in the transaction data and we loop over the inputs and delete the transactionHash and the blockNumber
    const optimizedInputs = transaction.inputs?.map((input) => {
      const { transactionHash, blockNumber, ...rest } = input;
      return rest;
    });

    const txContent = JSON.stringify({
      [dataKeys.index]: transaction.index,
      [dataKeys.timestamp]: transaction.timestamp,
      [dataKeys.inputs]: optimizedInputs,
    });
    await redisClient.hSet(block, txId, txContent);
    // If there's existing data, it is not modified because we're using $setOnInsert equivalent behavior
  }
}

export async function updateOutputs(
  transaction: ITransaction,
  outputs: IOutput[]
) {
  const redisClient = await getRedisClient();

  for (const output of outputs) {
    const outputKey = `${dataKeys.output}:${output.hash.toLowerCase()}`;

    // Fetch the existing output data
    let outputData: any = {};

    // Update the output data
    outputData[dataKeys.index] = output.hash.split(":")[1];
    outputData[dataKeys.address] = output?.address?.toLowerCase();
    outputData[dataKeys.blockNumber] = transaction.blockNumber;
    outputData[dataKeys.transactionIndex] = transaction.index;
    outputData[dataKeys.value] = output.value;

    // Save the updated output data
    await redisClient.set(outputKey, JSON.stringify(outputData));

    // Add the output hash to the transaction's outputs list
    // This will not add duplicates

    if (output.hash.split(":")[0] !== transaction.hash.toLowerCase()) {
      throw new Error(
        `Output hash ${output.hash} does not match transaction hash ${transaction.hash}`
      );
    }
    const transactionOutputsKey = `tx:${transaction.hash.toLowerCase()}:outputs`;

    // check if the transactionOutputsKey already exists in the rpush. If yes, throw error
    const existingOutputData = await redisClient.lRange(
      transactionOutputsKey,
      0,
      -1
    );
    if (existingOutputData.includes(outputData[dataKeys.index])) {
      console.error(
        `Output hash ${output.hash} already exists in transaction ${transaction.hash}`
      );
    } else {
      await redisClient.rPush(
        transactionOutputsKey,
        outputData[dataKeys.index]
      );
    }
  }
}

export const getTxOutPutHashes = async (txHash: string): Promise<string[]> => {
  const redisClient = await getRedisClient();
  const transactionOutputsKey = `tx:${txHash.toLowerCase()}:outputs`;

  // Get the list of output indexes associated with the transaction
  const outputIndexes = await redisClient.lRange(transactionOutputsKey, 0, -1);

  // we create the output hashes by concatenating the tx hash with the output index
  const outputs = outputIndexes.map(
    (index) => `${txHash.toLowerCase()}:${index}`
  );

  // we check for duplicates; if there any we throw an error
  const duplicates = outputs.filter(
    (output, index) => outputs.indexOf(output) !== index
  );
  if (duplicates.length > 0) {
    console.error(
      `Duplicate output hashes found for transaction ${txHash}: ${duplicates.join(
        ", "
      )}`
    );
  }
  // unique outputs. This should be removed again and instead throw an error above but is temporarily necessary to speed up our development cycle.
  return Array.from(new Set(outputs));
};

export const setInscriptionOnOutput = async (
  output: IOutput,
  inscriptionId: string
) => {
  const redisClient = await getRedisClient();

  // Define the output key
  const outputKey = `${dataKeys.output}:${output.hash.toLowerCase()}`;

  // Fetch the existing output data
  const existingOutputData = await redisClient.get(outputKey);
  let outputData;
  if (existingOutputData) {
    outputData = JSON.parse(existingOutputData);
  } else {
    throw new Error(`Output ${output.hash} does not exist`);
  }

  // add the inscriptions to the inscriptions array
  outputData[dataKeys.inscriptions] = outputData[dataKeys.inscriptions] || [];
  outputData[dataKeys.inscriptions].push(inscriptionId);

  // Save the updated output data
  await redisClient.set(outputKey, JSON.stringify(outputData));
};

export const setOutputsFetched = async (transaction: ITransaction) => {
  const redisClient = await getRedisClient();

  // Fetch the existing transaction data
  const block = String(transaction.blockNumber);
  const txId = transaction.hash;
  const existingTransactionData = await redisClient.hGet(block, txId);

  let transactionData;
  if (existingTransactionData) {
    transactionData = JSON.parse(existingTransactionData);
  } else {
    // If there's no existing data, create a new object
    transactionData = {};
  }

  // Set the outputsFetched flag
  transactionData[dataKeys.outputsFetched] = true;

  // Save the updated transaction data
  await redisClient.hSet(block, txId, JSON.stringify(transactionData));
};

export const getOutputsAlreadyFetched = async (
  transaction: ITransaction
): Promise<boolean> => {
  const redisClient = await getRedisClient();

  // Fetch the existing transaction data
  const block = String(transaction.blockNumber);
  const txId = transaction.hash;
  const existingTransactionData = await redisClient.hGet(block, txId);

  if (existingTransactionData) {
    const transactionData = JSON.parse(existingTransactionData);
    return transactionData[dataKeys.outputsFetched] || false;
  } else {
    // If there's no existing data, return false
    return false;
  }
};

export const getTransactionsForBlock = async (
  blockNumber: number
): Promise<ITransaction[]> => {
  const redisClient = await getRedisClient();

  // Fetch the transaction data for each hash

  const block = String(blockNumber);
  const stringifiedTransactions = await redisClient.hGetAll(block);

  const keys = Object.keys(stringifiedTransactions);

  const transactions = Object.values(stringifiedTransactions).map((tx, i) => {
    const unpackedTx = unpackTransactionDataFromRedis(JSON.parse(tx));
    const inputs = unpackedTx.inputs;

    const enrichedInputs = inputs.map((input: any) => {
      return { ...input, blockNumber, transactionHash: keys[i] };
    });
    return {
      ...unpackedTx,
      blockNumber,
      hash: keys[i],
      inputs: enrichedInputs,
    };
  });

  // Sort the transactions by index
  transactions.sort((a, b) => a.index - b.index);

  return transactions;
};

export const deleteTransactionsForBlock = async (blockNumber: number) => {
  const redisClient = await getRedisClient();

  // get all keys
  const block = String(blockNumber);
  const keys = await redisClient.hKeys(block);

  // delete all keys
  await redisClient.hDel(block, keys);

  console.log(`Deleted ${keys.length} transactions for block ${blockNumber}`);
};

export const getOutput = async (
  outputHash: string,
  shouldExist: boolean = false
): Promise<IOutput> => {
  const redisClient = await getRedisClient();

  // Define the output key
  const outputKey = `${dataKeys.output}:${outputHash.toLowerCase()}`;

  // Fetch the existing output data
  const existingOutputData = await redisClient.get(outputKey);
  let outputData;

  if (existingOutputData) {
    outputData = unpackOutputDataFromRedis(
      JSON.parse(existingOutputData)
    ) as any;
    outputData.transactionHash = outputHash.split(":")[0].toLowerCase();
    outputData.hash = outputHash.toLowerCase();
  } else {
    // If there's no existing data but we expected it to exist, throw an error
    if (shouldExist) {
      throw new Error(`Output ${outputHash} not found`);
    }
  }

  return outputData;
};
