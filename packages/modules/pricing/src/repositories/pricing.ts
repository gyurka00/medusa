import {
  flattenObjectToKeyValuePairs,
  isPresent,
  MedusaError,
  MikroOrmBase,
  PriceListStatus,
} from "@medusajs/framework/utils"

import {
  CalculatedPriceSetDTO,
  Context,
  PricingContext,
  PricingFilters,
  PricingRepositoryService,
} from "@medusajs/framework/types"
import { Knex, SqlEntityManager } from "@mikro-orm/postgresql"

export class PricingRepository
  extends MikroOrmBase
  implements PricingRepositoryService
{
  constructor() {
    // @ts-ignore
    // eslint-disable-next-line prefer-rest-params
    super(...arguments)
  }

  async calculatePrices(
    pricingFilters: PricingFilters,
    pricingContext: PricingContext = { context: {} },
    sharedContext: Context = {}
  ): Promise<CalculatedPriceSetDTO[]> {
    const manager = this.getActiveManager<SqlEntityManager>(sharedContext)
    const knex = manager.getKnex()
    const context = pricingContext.context || {}

    // Quantity is used to scope money amounts based on min_quantity and max_quantity.
    // We should potentially think of reserved words in pricingContext that can't be used in rules
    // or have a separate pricing options that accept things like quantity, price_list_id and other
    // pricing module features
    const quantity = context.quantity
    delete context.quantity

    // Currency code here is a required param.
    const currencyCode = context.currency_code
    delete context.currency_code

    if (!currencyCode) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Method calculatePrices requires currency_code in the pricing context`
      )
    }

    const isContextPresent = Object.entries(context).length || !!currencyCode

    // Only if the context is present do we need to query the database.
    // We don't get anything from the db otherwise.
    if (!isContextPresent) {
      return []
    }

    const flattenedContext = Object.entries(
      flattenObjectToKeyValuePairs(context)
    ).filter(
      ([key, value]) =>
        (isPresent(value) && !Array.isArray(value)) ||
        (Array.isArray(value) && value.flat(1).length)
    )

    // Gets all the prices where rules match for each of the contexts
    // that the price set is configured for
    const priceSubQueryKnex = knex({
      price: "price",
    })
      .select({
        id: "price.id",
        amount: "price.amount",
        raw_amount: "price.raw_amount",
        min_quantity: "price.min_quantity",
        max_quantity: "price.max_quantity",
        currency_code: "price.currency_code",
        price_set_id: "price.price_set_id",
        rules_count: "price.rules_count",
        price_list_id: "price.price_list_id",
        pl_rules_count: "pl.rules_count",
        pl_type: "pl.type",
        has_price_list: knex.raw(
          "case when price.price_list_id IS NULL then False else True end"
        ),
      })
      .leftJoin("price_rule as pr", "pr.price_id", "price.id")
      .leftJoin("price_list as pl", function () {
        this.on("pl.id", "price.price_list_id").andOn(
          "pl.status",
          knex.raw("?", [PriceListStatus.ACTIVE])
        )
      })
      .leftJoin("price_list_rule as plr", "plr.price_list_id", "pl.id")
      .groupBy("price.id", "pl.id")
      .having(
        knex.raw(
          "count(pr.attribute) = price.rules_count AND price.price_list_id IS NULL"
        )
      )
      .orHaving(
        knex.raw(
          "count(DISTINCT plr.attribute) = pl.rules_count AND price.price_list_id IS NOT NULL"
        )
      )

    const buildOperatorQueries = (
      operatorGroupBuilder: Knex.QueryBuilder,
      value
    ) => {
      operatorGroupBuilder
        .where((operatorBuilder) => {
          operatorBuilder
            .where("pr.operator", "gte")
            .whereRaw("? >= pr.value::numeric", [value])
        })
        .orWhere((operatorBuilder) => {
          operatorBuilder
            .where("pr.operator", "gt")
            .whereRaw("? > pr.value::numeric", [value])
        })
        .orWhere((operatorBuilder) => {
          operatorBuilder
            .where("pr.operator", "lt")
            .whereRaw("? < pr.value::numeric", [value])
        })
        .orWhere((operatorBuilder) => {
          operatorBuilder
            .where("pr.operator", "lte")
            .whereRaw("? <= pr.value::numeric", [value])
        })
        .orWhere((operatorBuilder) => {
          operatorBuilder
            .where("pr.operator", "eq")
            .whereRaw("? = pr.value::numeric", [value])
        })
    }

    priceSubQueryKnex.orWhere((priceBuilder) => {
      priceBuilder
        .whereNull("price.price_list_id")
        .andWhere((withoutPriceListBuilder) => {
          for (const [key, value] of flattenedContext) {
            withoutPriceListBuilder.orWhere((orBuilder) => {
              orBuilder.where("pr.attribute", key)

              if (typeof value === "number") {
                buildOperatorQueries(orBuilder, value)
              } else {
                const normalizeValue = Array.isArray(value) ? value : [value]

                orBuilder.whereIn("pr.value", normalizeValue)
              }
            })
          }

          withoutPriceListBuilder.orWhere("price.rules_count", "=", 0)
        })
    })

    priceSubQueryKnex.orWhere((q) => {
      q.whereNotNull("price.price_list_id")
        .whereNull("pl.deleted_at")
        .andWhere(function () {
          this.whereNull("pl.starts_at").orWhere(
            "pl.starts_at",
            "<=",
            knex.fn.now()
          )
        })
        .andWhere(function () {
          this.whereNull("pl.ends_at").orWhere(
            "pl.ends_at",
            ">=",
            knex.fn.now()
          )
        })
        .andWhere(function () {
          this.andWhere(function () {
            for (const [key, value] of flattenedContext) {
              this.orWhere({ "plr.attribute": key })
              this.where(
                "plr.value",
                "@>",
                JSON.stringify(Array.isArray(value) ? value : [value])
              )
            }

            this.orWhere("pl.rules_count", "=", 0)
          })

          this.andWhere(function () {
            this.andWhere((contextBuilder) => {
              for (const [key, value] of flattenedContext) {
                contextBuilder.orWhere((orBuilder) => {
                  orBuilder.where("pr.attribute", key)

                  if (typeof value === "number") {
                    buildOperatorQueries(orBuilder, value)
                  } else {
                    const normalizeValue = Array.isArray(value)
                      ? value
                      : [value]

                    orBuilder.whereIn("pr.value", normalizeValue)
                  }
                })
              }

              contextBuilder.andWhere("price.rules_count", ">", 0)
            })
            this.orWhere("price.rules_count", "=", 0)
          })
        })
    })

    const priceSetQueryKnex = knex({
      ps: "price_set",
    })
      .select({
        id: "price.id",
        price_set_id: "ps.id",
        amount: "price.amount",
        raw_amount: "price.raw_amount",
        min_quantity: "price.min_quantity",
        max_quantity: "price.max_quantity",
        currency_code: "price.currency_code",
        rules_count: "price.rules_count",
        pl_rules_count: "price.pl_rules_count",
        price_list_type: "price.pl_type",
        price_list_id: "price.price_list_id",
        all_rules_count: knex.raw(
          "COALESCE(price.rules_count, 0) + COALESCE(price.pl_rules_count, 0)"
        ),
      })
      .join(priceSubQueryKnex.as("price"), "price.price_set_id", "ps.id")
      .whereIn("ps.id", pricingFilters.id)
      .andWhere("price.currency_code", "=", currencyCode)

      .orderBy([
        { column: "price.has_price_list", order: "asc" },
        { column: "all_rules_count", order: "desc" },
        { column: "amount", order: "asc" },
      ])

    if (quantity) {
      priceSetQueryKnex.where("price.min_quantity", "<=", quantity)
      priceSetQueryKnex.andWhere("price.max_quantity", ">=", quantity)
    } else {
      priceSetQueryKnex.andWhere(function () {
        this.andWhere("price.min_quantity", "<=", "1").orWhereNull(
          "price.min_quantity"
        )
      })
    }

    return await priceSetQueryKnex
  }
}
