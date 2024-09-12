import { Injectable, Req } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'

import { LLANA_AUTH_TABLE } from '../app.constants'
import { Auth, AuthAPIKey, AuthLocation, AuthRestrictionsResponse, AuthType } from '../types/auth.types'
import { DatabaseFindOneOptions, DatabaseSchema, QueryPerform, WhereOperator } from '../types/database.types'
import { FindManyResponseObject } from '../types/response.types'
import { Env } from '../utils/Env'
import { findDotNotation } from '../utils/Find'
import { Logger } from './Logger'
import { Query } from './Query'
import { Schema } from './Schema'

@Injectable()
export class Authentication {
	constructor(
		private readonly configService: ConfigService,
		private readonly logger: Logger,
		private readonly query: Query,
		private readonly schema: Schema,
		private readonly jwtService: JwtService,
	) {}

	/**
	 * Create entity schema from database schema
	 * @param schema
	 */

	async auth(@Req() req): Promise<AuthRestrictionsResponse> {
		const authentications = this.configService.get<Auth[]>('auth')

		if (!authentications) {
			return {
				valid: true,
			}
		}

		const auth_schema = await this.schema.getSchema(LLANA_AUTH_TABLE)

		let auth_passed: AuthRestrictionsResponse = {
			valid: false,
			message: 'Unauthorized',
		}

		for (const auth of authentications) {
			if (auth_passed.valid) continue

			if (!auth.type) {
				auth_passed = {
					valid: false,
					message: 'System configuration error: Restriction type required',
				}
				continue
			}

			//Is the restriction required on the current route?
			let check_required = true

			const rules = (await this.query.perform(QueryPerform.FIND_MANY, {
				schema: auth_schema,
				where: [
					{
						column: 'auth',
						operator: WhereOperator.equals,
						value: auth.type,
					},
				],
			})) as FindManyResponseObject

			const excludes = rules.data.filter(rule => rule.exclude)
			const includes = rules.data.filter(rule => rule.exclude)

			if (excludes) {
				for (const exclude of excludes) {
					if (req.originalUrl.includes(exclude.table)) {
						check_required = false
					}
				}
			}

			if (includes) {
				for (const include of includes) {
					if (req.originalUrl.includes(include.table)) {
						check_required = true
					}
				}
			}

			if (!check_required) continue

			let identity_column
			let schema: DatabaseSchema

			try {
				schema = await this.schema.getSchema(auth.table.name)
			} catch (e) {
				this.logger.error(`[Authentication][auth] Table ${auth.table.name} not found`, { e })
				return { valid: false, message: `No Schema Found For Table ${auth.table.name}` }
			}

			if (auth.table.identity_column) {
				identity_column = auth.table.identity_column
			} else {
				identity_column = schema.primary_key
			}

			switch (auth.type) {
				case AuthType.APIKEY:
					if (!auth.name) {
						auth_passed = {
							valid: false,
							message: 'System configuration error: API key name required',
						}
						continue
					}

					if (!auth.location) {
						auth_passed = {
							valid: false,
							message: 'System configuration error: API key location required',
						}
						continue
					}

					let req_api_key

					switch (auth.location) {
						case AuthLocation.HEADER:
							if (!req.headers[auth.name]) {
								auth_passed = {
									valid: false,
									message: `API key header ${auth.name} required`,
								}
								continue
							}
							req_api_key = req.headers[auth.name]
							break

						case AuthLocation.QUERY:
							if (!req.query[auth.name]) {
								auth_passed = {
									valid: false,
									message: `API key query ${auth.name} required`,
								}
								continue
							}
							req_api_key = req.query[auth.name]
							break

						case AuthLocation.BODY:
							if (!req.body[auth.name]) {
								auth_passed = {
									valid: false,
									message: `API key body ${auth.name} required`,
								}
								continue
							}
							req_api_key = req.body[auth.name]
							break
					}

					if (!req_api_key) {
						auth_passed = {
							valid: false,
							message: 'API key required',
						}
						continue
					}

					if (Env.IsTest()) {
						this.logger.debug(`[Authentication][auth] Skipping API key check in test environment`)
						auth_passed = {
							valid: true,
						}
						continue
					}

					const api_key_config = auth.table as AuthAPIKey

					if (!api_key_config || !api_key_config.name) {
						this.logger.error(
							`[Authentication][auth] System configuration error: API Key lookup table not found`,
						)
						auth_passed = {
							valid: false,
							message: 'System configuration error: API Key lookup table not found',
						}
						continue
					}

					if (!api_key_config.column) {
						this.logger.error(
							`[Authentication][auth] System configuration error: API Key lookup column not found`,
						)
						auth_passed = {
							valid: false,
							message: 'System configuration error: API Key lookup column not found',
						}
						continue
					}

					const options: DatabaseFindOneOptions = {
						schema,
						fields: [`${api_key_config.name}.${identity_column}`],
						where: [
							{
								column: api_key_config.column,
								operator: WhereOperator.equals,
								value: req_api_key,
							},
						],
						relations: [],
					}

					const { valid, message, fields, relations } = await this.schema.validateFields(
						schema,
						api_key_config.column,
					)
					if (!valid) {
						auth_passed = {
							valid: false,
							message,
						}
					}

					for (const field of fields) {
						if (!options.fields.includes(field)) {
							options.fields.push(field)
						}
					}

					for (const relation of relations) {
						if (!options.relations.find(r => r.table === relation.table)) {
							options.relations.push(relation)
						}
					}

					if (this.configService.get('database.deletes.soft')) {
						options.where.push({
							column: this.configService.get('database.deletes.soft'),
							operator: WhereOperator.null,
						})
					}

					const result = await this.query.perform(QueryPerform.FIND, options)

					//key does not match - return unauthorized immediately
					if (
						!result ||
						(!result[api_key_config.column] && findDotNotation(result, api_key_config.column)) !==
							req_api_key
					) {
						this.logger.debug(`[Authentication][auth] API key not found`, {
							key: req_api_key,
							column: api_key_config.column,
							result,
						})
						return { valid: false, message: 'Unauthorized' }
					}

					if (!result[identity_column]) {
						this.logger.error(
							`[Authentication][auth] Identity column ${identity_column} not found in result`,
							{ result },
						)
						return {
							valid: false,
							message: `System configuration error: Identity column ${identity_column} not found`,
						}
					}

					this.logger.debug(`[Authentication][auth] User #${result[identity_column]} identified successfully`)

					auth_passed = {
						valid: true,
						user_identifier: result[identity_column],
					}

					break

				case AuthType.JWT:
					const jwt_token = req.headers['authorization']?.split(' ')[1]

					if (!jwt_token) {
						auth_passed = {
							valid: false,
							message: 'JWT token required',
						}
						continue
					}

					const jwt_config = this.configService.get<any>('jwt')

					try {
						const payload = await this.jwtService.verifyAsync(jwt_token, {
							secret: jwt_config.secret,
						})

						auth_passed = {
							valid: true,
							user_identifier: payload.sub,
						}
					} catch {
						auth_passed = {
							valid: false,
							message: 'JWT Authentication Failed',
						}
					}

					continue
			}
		}

		return auth_passed
	}
}
