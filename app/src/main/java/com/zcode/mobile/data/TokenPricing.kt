package com.zcode.mobile.data

/**
 * Token 费用估算（按智谱 BigModel 牌价，单位：元 / 100 万 tokens）。
 *
 * ⚠ 价格为预估默认值，请按 https://open.bigmodel.cn 的最新定价校准；
 * 计费口径：cacheRead 按「缓存命中价」、其余输入（含缓存写入）按输入价、输出按输出价。
 */
object TokenPricing {

    data class ModelPrice(
        val input: Double,      // 输入 ¥/M
        val cacheRead: Double,  // 缓存命中输入 ¥/M
        val output: Double,     // 输出 ¥/M
    )

    private val TABLE = mapOf(
        "GLM-5.3-Flash" to ModelPrice(input = 0.2, cacheRead = 0.04, output = 1.0),
        "GLM-5.3" to ModelPrice(input = 4.0, cacheRead = 0.8, output = 16.0),
        "GLM-4.5-Flash" to ModelPrice(input = 0.2, cacheRead = 0.04, output = 1.0),
        "GLM-4.5" to ModelPrice(input = 4.0, cacheRead = 0.8, output = 16.0),
    )
    private val DEFAULT = TABLE["GLM-5.3"]!!

    fun priceFor(modelId: String?): ModelPrice {
        if (modelId == null) return DEFAULT
        // id 可能是 provider/model 或带变体后缀，取最长前缀命中
        val hit = TABLE.entries
            .filter { modelId.contains(it.key, ignoreCase = true) }
            .maxByOrNull { it.key.length }
        return hit?.value ?: DEFAULT
    }

    /** 估算一回合费用（元）。cacheWrite 视作普通输入计价。 */
    fun costCny(
        modelId: String?,
        inputTokens: Long,
        outputTokens: Long,
        cacheReadTokens: Long = 0,
    ): Double {
        val p = priceFor(modelId)
        val nonCached = (inputTokens - cacheReadTokens).coerceAtLeast(0)
        return nonCached / 1_000_000.0 * p.input +
            cacheReadTokens / 1_000_000.0 * p.cacheRead +
            outputTokens / 1_000_000.0 * p.output
    }

    /** 费用展示：小额保留 3 位，一般 2 位 */
    fun fmtCny(yuan: Double): String = if (yuan < 0.1) "≈¥%.3f".format(yuan) else "≈¥%.2f".format(yuan)
}
