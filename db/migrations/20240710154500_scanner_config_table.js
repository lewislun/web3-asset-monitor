import { Model } from 'objection'

import { getOnUpdateTriggerSql } from '../../lib/index.js'

/**
 * @param {import('knex').Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
	Model.knex(knex)

	// create asset query table
	await knex.schema.createTable('asset_scanner_configs', t => {
		t.increments('id').primary()
		t.string('chain', 255).notNullable()
		t.string('type', 255).notNullable()
		t.string('endpoint', 255).notNullable()
		t.string('api_key', 255)
		t.string('rate_limiter_key', 255)
		t.boolean('is_enabled').notNullable().defaultTo(true)
		t.timestamp('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'))
		t.timestamp('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'))
	})

	await knex.schema.createTable('asset_infos', t => {
		t.increments('id').primary()
		t.string('chain', 255).notNullable()
		t.string('code', 255).notNullable().index()
		t.enum('type', ['cex-token', 'native-token', 'secondary-token', 'nft', 'others']).notNullable()
		t.string('address', 255)
		t.timestamp('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'))
		t.timestamp('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'))

		t.unique(['chain', 'code'])
	})

	knex.raw(getOnUpdateTriggerSql('asset_infos'))
	knex.raw(getOnUpdateTriggerSql('asset_scanner_configs'))
}

/**
 * @param {import('knex').Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
	Model.knex(knex)

	await knex.schema.dropTableIfExists('asset_scanner_configs')
}
