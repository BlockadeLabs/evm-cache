const hexToBytea = require('../../util/hexToBytea.js');

class ContractQueries {
	static addContract(
		blockchain_id,
		address,
		contract_standard,
		abi
	) {
		return {
			text: `
				INSERT INTO
					contract (
						blockchain_id,
						address,
						contract_standard_id,
						abi
					)
				VALUES (
					$1,
					$2,
					COALESCE((
						SELECT
							contract_standard_id
						FROM
							contract_standard
						WHERE
							version = 0 AND
							standard = $3
					), NULL),
					$4
				)
				ON CONFLICT DO NOTHING
				RETURNING *;
			`,
			values: [
				blockchain_id,
				hexToBytea(address),
				contract_standard,
				abi
			]
		}
	}

	static getContractsInBlockRange(
		blockchain_id,
		start_block_number,
		end_block_number
	) {
		return {
			text: `
				SELECT
					t.contract_address,
					t.input
				FROM
					transaction t,
					block b
				WHERE
					b.blockchain_id = $1 AND
					b.number >= $2 AND
					b.number < $3 AND
					b.block_id = t.block_id AND
					t.contract_address IS NOT NULL;
			`,
			values: [
				blockchain_id,
				start_block_number,
				end_block_number
			]
		}
	}
}

module.exports = ContractQueries;