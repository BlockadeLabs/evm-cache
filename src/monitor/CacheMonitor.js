const log = require('loglevel');
const Database = require('../database/Database.js');
const sleep = require('../util/sleep.js');
const byteaBufferToHex = require('../util/byteaBufferToHex.js');

const BlockQueries = require('../database/queries/BlockQueries.js');
const TransactionQueries = require('../database/queries/TransactionQueries.js');

const ContractController = require('../controller/ContractController.js');

class CacheMonitor {
	constructor(options) {
		this.blockchain_id = options.blockchain_id;
		this.evmClient = options.client;
		this.startBlockOverride = options.startBlockOverride;
		this.endBlockOverride = options.endBlockOverride;
		this.Client = null; // Covered in start()

		this.reviewBlockLimit = 15;
		this.comprehensiveReviewBlockLimit = 100;
		this.comprehensiveReviewCounter = 0;
		this.comprehensiveReviewCountMod = 250;

		this.cc = new ContractController(this.evmClient);
	}

	async start() {
		Database.connect((Client) => {
			Client.query(BlockQueries.getLatestBlock(this.blockchain_id), async (result) => {
				this.Client = Client;

				let latest_number;
				if (this.startBlockOverride !== false) {
					latest_number = this.startBlockOverride;
					log.info("Using start block number override:", latest_number);
				} else if (!result || !result.rowCount) {
					latest_number = 0;
					log.info("No latest block, starting at 0");
				} else {
					// Rerun the current latest number - see truncate below
					latest_number = parseInt(result.rows[0].number, 10);
					log.info("Retrieved latest block:", latest_number);
				}

				// First we're going to truncate everything related to the current block
				// so we can stop and start without missing data in-between
				await this.flushBlock(latest_number);

				this.mainLoop(latest_number);
			});
		});
	}

	async flushBlock(block_number) {
		log.info("Flushing", block_number);

		await this.Client.query(TransactionQueries.deleteLogs(
			this.blockchain_id,
			block_number
		));

		log.info("Logs deleted, cascading to events and related tables");

		await this.Client.query(TransactionQueries.deleteTransactions(
			this.blockchain_id,
			block_number
		));

		log.info("Transactions deleted");

		await this.Client.query(BlockQueries.deleteOmmers(
			this.blockchain_id,
			block_number
		));

		log.info("Ommers deleted");

		await this.Client.query(BlockQueries.deleteBlock(
			this.blockchain_id,
			block_number
		));

		log.info("Completed flushing", block_number);
	}

	async mainLoop(block_number) {
		if (this.endBlockOverride !== false && block_number >= this.endBlockOverride) {
			log.info("Reached endBlockOverride:", this.endBlockOverride);
			process.exit();
		}

		this.getBlock(block_number, {
			'atBlockchainHead' : async (block_number) => {
				//log.debug("No block found:", block_number);

				// Go back and review the last N blocks
				if (++this.comprehensiveReviewCounter % this.comprehensiveReviewCountMod === 0) {
					log.info(`Performing a comprehensive review of the last ${this.comprehensiveReviewBlockLimit} blocks.`);

					for (
						let prior_block_number = block_number - this.comprehensiveReviewBlockLimit;
						prior_block_number < block_number - 1;
						prior_block_number++
					) {
						this.getBlock.call(this, prior_block_number);
					}

					// Wait before checking for the next block
					await sleep(15000);
				} else {
					for (
						let prior_block_number = block_number - this.reviewBlockLimit;
						prior_block_number < block_number - 1;
						prior_block_number++
					) {
						this.getBlock.call(this, prior_block_number, {
							'foundDuringReviewBlock' : async (block_number, block_hash) => {
								log.info(`* Found new previous block at number ${block_number}: ${block_hash}`);
							}
						});
					}

					// Wait before checking for the next block
					await sleep(2500);
				}

				// Try this block again
				return this.mainLoop(parseInt(block_number, 10));
			},
			'blockAlreadyExists' : async (block_number, block_hash) => {
				// Move to the next block
				log.info(`Block with hash ${block_hash} found, skipping.`);
				this.mainLoop(parseInt(block_number, 10) + 1);
			},
			'moveToNextBlock' : async (block_number) => {
				// Move to the next block
				this.mainLoop(parseInt(block_number, 10) + 1);
			}
		});
	}

	async getBlock(block_number, callbacks = {}) {
		// Lock and key to prevent multiple callback hell
		let localErrorRecovered = false;

		this.evmClient.getBlock(block_number, async (err, block, t1, t2, t3) => {
			if (err) {
				// If we get an invalid JSON RPC response, the node is down, cycle to the next one
				if (
					String(err).indexOf('Invalid JSON RPC response') !== -1 ||
					String(err).toUpperCase().indexOf('CONNECTION TIMEOUT') !== -1
				) {
					if (!localErrorRecovered) {
						// Gate the cycle & mainloop from happening a second time
						localErrorRecovered = true;

						log.error("** JSON RPC or connection timeout failure in CacheMonitor::getBlock, cycling to next node **");

						// Cycle to the next node...
						this.evmClient.cycleNodes();

						// And try again
						return this.mainLoop(parseInt(block_number, 10));
					} else {

						// For debugging
						log.error("** Received duplicate local timeout or JSON RPC error, already cycled **");

						return;
					}
				} else {
					// Print the error
					log.error("Unknown error:", err);

					// Sleep a bit before we fail out, because this can cause a death spiral of removing blocks
					await sleep(2500);
					process.exit(1);
				}
			} else if (!block) {
				if (callbacks.hasOwnProperty('atBlockchainHead')) {
					callbacks.atBlockchainHead.call(this, block_number);
				}

				return;
			}

			// Make sure that we haven't already stored this block & make sure tx count is valid
			let checkRes = await this.Client.query(BlockQueries.getBlockByHash(
				this.blockchain_id, block.hash
			));

			if (checkRes && checkRes.rowCount) {
				if (block.transactions.length === parseInt(checkRes.rows[0].transaction_count, 10)) {
					// Block transactions are valid for this hash, but what about the number as a whole?
					// This handles previous blocks at this height that have been uncled
					let numCheckRes = await this.Client.query(BlockQueries.getBlockTransactionCount(
						this.blockchain_id, block_number
					));

					if (numCheckRes && numCheckRes.rowCount && block.transactions.length === parseInt(numCheckRes.rows[0].count, 10)) {
						// Everything is in order, ignore and move on
						if (callbacks.hasOwnProperty('blockAlreadyExists')) {
							callbacks.blockAlreadyExists.call(this, block_number, block.hash);
						}
					} else {
						log.info(`At block #${block_number}, found stale transactions. Previous transaction count: ${numCheckRes.rows[0].count}, expected: ${block.transactions.length}`);

						// There are stale blocks at this height, let's start fresh
						storeBlockAssocData.call(this, block);
					}
				} else {
					// Maybe delete any ommer that mentions this?
					// Or do we add a flag to block that says "selected block"?
					// Alternatively, just taking whatever the current head is in the database
					// should give us all the information we need, unless we have an attack that
					// reorgs beyond the regular number of blocks within a given timeframe
					log.info(`At a re-instated block, #${block_number}, restoring data. Previous transaction count: ${checkRes.rows[0].transaction_count}, expected: ${block.transactions.length}`);

					// Go ahead and store all of the data all over again, which
					// migrates any moved data back to the de-facto block
					storeBlockAssocData.call(this, block);
				}

				// Stop here.
				return;

			} else {
				if (callbacks.hasOwnProperty('foundDuringReviewBlock')) {
					callbacks.foundDuringReviewBlock.call(this, block_number, block.hash);
				} else {
					log.info(`Found new block at #${block.number}`);
				}
			}

			// Save the block
			this.Client.query(BlockQueries.addBlock(
				this.blockchain_id,
				block.number,
				block.hash,
				block.parentHash,
				block.nonce,
				block.gasLimit,
				block.gasUsed,
				block.timestamp,
				block.sha3Uncles,
				block.logsBloom,
				block.transactionsRoot,
				block.receiptsRoot,
				block.stateRoot,
				block.mixHash,
				block.miner,
				block.difficulty,
				block.extraData,
				block.size
			), async (result) => {
				if (!result || !result.rowCount) {
					this.Client.release();
					log.error('No result returned for');
					log.error(block);
					log.error('^^ No result returned ^^');
					process.exit(1);
				}

				storeBlockAssocData.call(this, block);
			});
		});

		async function storeBlockAssocData(block) {
			// Queue up all of the tasks
			let promises = [];

			// Use a transaction for all of the promises
			await this.Client.query('BEGIN;');

			// Delete all associated data at this number prior to adding data
			// We do this because some transactions are replaced by new transactions with
			// the same nonce, but higher gas prices -- so they aren't replaced automatically
			await this.Client.query(TransactionQueries.deleteLogs(
				this.blockchain_id,
				block.number
			));

			await this.Client.query(TransactionQueries.deleteTransactions(
				this.blockchain_id,
				block.number
			));

			// Insert any ommers
			if (block.uncles && block.uncles.length) {
				promises.push(this.addOmmers(block.hash, block.uncles));
			}

			for (let idx = 0; idx < block.transactions.length; idx++) {
				promises.push(this.getTransaction(block.hash, block.transactions[idx]));
			}

			Promise.all(promises).then(async values => {
				// Commit the transaction for all of the promises
				await this.Client.query('COMMIT;');

				if (callbacks.hasOwnProperty('moveToNextBlock')) {
					callbacks.moveToNextBlock.call(this, block.number);
				}

				return;
			}).catch(async error => {
				// Rollback the transaction for all of the promises
				await this.Client.query('ROLLBACK;');

				/*
				// If we get an invalid JSON RPC response, the node is down, cycle to the next one
				if (
					String(error).indexOf('Invalid JSON RPC response') !== -1 ||
					String(error).toUpperCase().indexOf('CONNECTION TIMEOUT') !== -1
				) {
					log.error("** JSON RPC or connection timeout failure in CacheMonitor::storeBlockAssocData, cycling to next node **");

					// Cycle to the next node...
					this.evmClient.cycleNodes();

					// And try again
					return this.mainLoop(parseInt(block_number, 10));
				}
				*/

				await sleep(1000);
				log.error('Promises failed for retrieving all block data');
				log.error(`Error: ${error}`);
				process.exit(1);
			});
		}
	}

	async addOmmers(nibling_block_hash, ommers) {
		let promises = [];

		for (let idx = 0; idx < ommers.length; idx++) {
			promises.push(
				this.Client.query(BlockQueries.addOmmer(
					this.blockchain_id,
					ommers[idx],
					nibling_block_hash
				))
			);
		}

		return Promise.all(promises);
	}

	async getTransaction(block_hash, transaction) {
		let receipt = await this.evmClient.getTransactionReceipt(transaction.hash);

		if (!receipt) {
			log.info(`Transaction receipt not found for block. Dropping out to be re-inserted at a later iteration.\n\tBlock hash: ${block_hash}\n\tTX hash: ${transaction.hash}`);
			return;
		}

		// This is only for testing
		// We don't actually need this for anything
		/*
			// Make sure that we haven't already stored this block
			let checkRes = await this.Client.query(TransactionQueries.getTransactionByHash(
				transaction.hash
			));

			if (checkRes && checkRes.rowCount) {
				log.info(`Found transaction already included in original block ${byteaBufferToHex(checkRes.rows[0].block_hash)}, moving to ${block_hash}`);
			}
		*/

		// Add the transaction
		let result = await this.Client.query(TransactionQueries.addTransaction(
			block_hash,
			transaction.hash,
			transaction.nonce,
			transaction.transactionIndex,
			transaction.from,
			transaction.to,
			transaction.value,
			transaction.gasPrice,
			transaction.gas,
			transaction.input,
			receipt.status || null,
			receipt.contractAddress || null,
			transaction.v,
			transaction.r,
			transaction.s
		));

		if (!result || !result.rowCount) {
			this.Client.release();
			log.error('No result returned for');
			log.error(transaction);
			log.error('^^ No result returned in block ' + block_hash + ' ^^');
			process.exit(1);
		}

		if (!receipt.logs || !receipt.logs.length) {
			return;
		}

		// First we delete the logs in case we have to update them
		// There's no easier way for us to identify logs that have to be "updated"
		// based on the transaction being included in another block -- this changes
		// the log_index, so it's better to just wipe the associated logs and re-insert
		// ALSO, doing this will cascade all log row deletes to the associated event
		// tables that we're using for parsed logs
		await this.Client.query(TransactionQueries.deleteLogsByTransactionHash(transaction.hash));

		// Add the logs & any events
		for (let idx = 0; idx < receipt.logs.length; idx++) {
			let logResult = await this.Client.query(TransactionQueries.addLog(
				transaction.hash,
				receipt.logs[idx].blockNumber,
				receipt.logs[idx].logIndex,
				receipt.logs[idx].address,
				receipt.logs[idx].data,
				...receipt.logs[idx].topics
			));

			if (!logResult || !logResult.rowCount) {
				log.error(`** Could not store log with index ${receipt.logs[idx].logIndex} for transaction ${transaction.hash}`);
				continue;
			}

			await this.cc.setDecodedLog(this.Client, logResult.rows[0].log_id, receipt.logs[idx]);
		}
	}
}

module.exports = CacheMonitor;
