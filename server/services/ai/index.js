var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/services/ai/index.ts
var index_exports = {};
__export(index_exports, {
  analyzePortfolio: () => analyzePortfolio6,
  chat: () => chat6
});
module.exports = __toCommonJS(index_exports);

// src/services/ai/openai.ts
async function chat(message, config) {
  const baseURL = config.baseURL || "https://api.openai.com/v1";
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E OpenAI API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
  }
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model || "gpt-5-mini",
      messages: [
        { role: "user", content: message }
      ],
      temperature: 0.7
    })
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}
async function analyzePortfolio(portfolioData, config) {
  const prompt = `\u4F60\u662F\u4E00\u4E2A\u4E13\u4E1A\u7684\u57FA\u91D1\u6295\u8D44\u987E\u95EE\u3002\u8BF7\u5206\u6790\u4EE5\u4E0B\u6301\u4ED3\u57FA\u91D1\u6570\u636E\uFF0C\u8BC4\u4F30\u6574\u4F53\u98CE\u9669\uFF0C\u5E76\u7ED9\u51FA\u5177\u4F53\u7684\u6295\u8D44\u5EFA\u8BAE\u3001\u76EE\u6807\u4ED3\u4F4D\u53CA\u64CD\u4F5C\u884C\u52A8\u3002
\u6301\u4ED3\u57FA\u91D1\u6570\u636E\uFF1A
${JSON.stringify(portfolioData, null, 2)}

\u4F60\u5F53\u524D\u7684\u6295\u8D44\u7EAA\u5F8B\u6838\u5FC3\u7B56\u7565\uFF08\u5FC5\u987B\u4F5C\u4E3A\u6240\u6709\u5EFA\u8BAE\u7684\u91CD\u8981\u53C2\u8003\u4E0E\u7EA6\u675F\uFF0C\u6240\u6709\u64CD\u4F5C\u5EFA\u8BAE\u5747\u4E0D\u5F97\u8FDD\u80CC\u8FD9\u4E9B\u7EAA\u5F8B\uFF09\uFF1A
${portfolioData.strategies && portfolioData.strategies.length > 0 ? portfolioData.strategies.map((s, i) => `${i + 1}. ${s}`).join("\n") : "\u672A\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u7B56\u7565\uFF0C\u8BF7\u57FA\u4E8E\u7A33\u5065\u3001\u7406\u6027\u7684\u5E38\u89C4\u6295\u8D44\u7EAA\u5F8B\u7ED9\u51FA\u5EFA\u8BAE"}

\u8BF7\u4E25\u683C\u6309\u7167\u4EE5\u4E0B JSON \u683C\u5F0F\u8FDB\u884C\u56DE\u590D\uFF08\u4E0D\u8981\u5305\u542B\u4EFB\u4F55 markdown \u6807\u8BB0\u3001\`\`\`json \u5757\u3001\u591A\u4F59\u6587\u5B57\u6216\u6CE8\u91CA\uFF0C\u786E\u4FDD\u5176\u4E3A\u53EF\u4EE5\u76F4\u63A5\u89E3\u6790\u7684\u7EAF JSON \u5BF9\u8C61\uFF09\uFF1A
{
  "healthScore": \u7EC4\u5408\u5065\u5EB7\u5EA6\u5206\u503C (0-100\u7684\u6570\u5B57),
  "healthText": "\u7EC4\u5408\u5065\u5EB7\u5EA6\u72B6\u6001\u8BC4\u4EF7 (\u5982\u914D\u7F6E\u6781\u4F73\u3001\u914D\u7F6E\u826F\u597D\u3001\u914D\u6BD4\u4E00\u822C\u3001\u4E9F\u5F85\u8C03\u6574\u7B49\u77ED\u8BED)",
  "healthColor": "\u72B6\u6001\u989C\u8272\u4EE3\u7801 (\u5982 #34a853 \u4EE3\u8868\u6781\u4F73/\u826F\u597D, #ff9500 \u4EE3\u8868\u4E00\u822C, #ff3b30 \u4EE3\u8868\u8F83\u5DEE)",
  "deviationText": "\u5927\u7C7B\u8D44\u4EA7\u504F\u79BB\u72B6\u6001\u8BF4\u660E (\u6839\u636E\u4F60\u5BF9\u8BE5\u7EC4\u5408\u5404\u5927\u7C7B\u504F\u79BB\u60C5\u51B5\u7684\u4E13\u4E1A\u8BC4\u4EF7)",
  "riskScore": \u8BC4\u4F30\u98CE\u9669\u5206\u503C (0-100\u7684\u6570\u5B57),
  "summary": "\u4ECA\u65E5\u64CD\u4F5C\u5EFA\u8BAE\u7684\u603B\u7ED3 (\u7ED3\u5408\u6295\u8D44\u7EAA\u5F8B\u6838\u5FC3\u7B56\u7565\uFF0C\u7528\u4E00\u53E5\u8BDD\u6982\u62EC\u4ECA\u5929\u6700\u5E94\u6267\u884C\u7684\u64CD\u4F5C\u4E0E\u7EAA\u5F8B\u63D0\u9192)",
  "rebalanceSuggestion": "\u5982\u4F55\u7EC4\u5408\u914D\u6BD4\u964D\u4F4E\u98CE\u9669\u7684\u4E00\u53E5\u8BDD\u5EFA\u8BAE (\u53EA\u7528\u4E00\u53E5\u8BDD\uFF0C\u7ED3\u5408\u5F53\u524D\u5927\u7C7B\u8D44\u4EA7\u6784\u6210\uFF1A\u82E5\u67D0\u5927\u7C7B\u5360\u6BD4\u8FC7\u9AD8\u5219\u6307\u51FA\u5E76\u7ED9\u51FA\u5BF9\u5E94\u7684\u8C03\u4ED3\u65B9\u5411\uFF0C\u4F8B\u5982\u6743\u76CA\u7C7B\u504F\u9AD8\u5EFA\u8BAE\u9002\u5EA6\u589E\u914D\u503A\u5238/\u7A33\u5065\u8D44\u4EA7\u5E76\u5206\u6563\u884C\u4E1A\uFF0C\u503A\u5238\u7C7B\u504F\u9AD8\u5219\u5EFA\u8BAE\u7EC4\u5408\u504F\u9632\u5B88\u3001\u53EF\u9002\u5EA6\u589E\u52A0\u6743\u76CA/\u6D77\u5916\u8D44\u4EA7\uFF1B\u4E0D\u8981\u76F2\u76EE\u5EFA\u8BAE\u589E\u914D\u5DF2\u6709\u8D44\u4EA7)",
  "suggestions": [
    {
      "fund": "\u57FA\u91D1\u540D\u79F0",
      "code": "\u57FA\u91D1\u4EE3\u7801",
      "action": "\u5EFA\u8BAE\u7684\u64CD\u4F5C\uFF1A\u5982\u6301\u6709\u3001\u52A0\u4ED3\u3001\u51CF\u4ED3\u3001\u8D4E\u56DE\u7B49",
      "reason": "\u5177\u4F53\u7684\u64CD\u4F5C\u7406\u7531\u548C\u5206\u6790",
      "targetPct": \u5EFA\u8BAE\u7684\u76EE\u6807\u4ED3\u4F4D\u767E\u5206\u6BD4\u6570\u503C (0-100\u7684\u6570\u5B57)
    }
  ]
}`;
  const text = await chat(prompt, config);
  let cleanText = text.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  cleanText = cleanText.trim();
  try {
    return JSON.parse(cleanText);
  } catch (err) {
    console.error("Failed to parse AI response as JSON:", text, err);
    return {
      healthScore: 60,
      healthText: "\u9700\u8981\u8C03\u6574",
      healthColor: "#ff3b30",
      deviationText: "\u65E0\u6CD5\u83B7\u53D6 AI \u8BCA\u65AD\u7ED3\u679C\uFF0C\u663E\u793A\u672C\u5730\u4F30\u7B97",
      riskScore: 50,
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// src/services/ai/deepseek.ts
async function chat2(message, config) {
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.deepseek.com/v1",
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || "",
    model: config.model || "deepseek-chat"
  };
  return chat(message, mergedConfig);
}
async function analyzePortfolio2(portfolioData, config) {
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.deepseek.com/v1",
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || "",
    model: config.model || "deepseek-chat"
  };
  return analyzePortfolio(portfolioData, mergedConfig);
}

// src/services/ai/kimi.ts
async function chat3(message, config) {
  const apiKey = config.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "";
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.moonshot.cn/v1",
    apiKey,
    model: config.model || "moonshot-v1-8k"
  };
  return chat(message, mergedConfig);
}
async function analyzePortfolio3(portfolioData, config) {
  const apiKey = config.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "";
  const mergedConfig = {
    ...config,
    baseURL: config.baseURL || "https://api.moonshot.cn/v1",
    apiKey,
    model: config.model || "moonshot-v1-8k"
  };
  return analyzePortfolio(portfolioData, mergedConfig);
}

// src/services/ai/gemini.ts
async function chat4(message, config) {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY || "";
  const model = config.model || "gemini-2.5-pro";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E Gemini API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
  }
  const isCustomBase = config.baseURL && !config.baseURL.includes("generativelanguage.googleapis.com");
  if (isCustomBase) {
    const mergedConfig = {
      ...config,
      baseURL: config.baseURL,
      apiKey,
      model
    };
    return chat(message, mergedConfig);
  }
  const baseUrl = config.baseURL || "https://generativelanguage.googleapis.com";
  const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const targetUrl = `${cleanBaseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: message }
          ]
        }
      ]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Response error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    throw new Error("Gemini API \u672A\u8FD4\u56DE\u6709\u6548\u7684 text \u5B57\u6BB5\uFF0C\u8BF7\u68C0\u67E5\u8F93\u5165\u6216\u6A21\u578B");
  }
  return textContent;
}
async function analyzePortfolio4(portfolioData, config) {
  const prompt = `\u4F60\u662F\u4E00\u4E2A\u4E13\u4E1A\u7684\u57FA\u91D1\u6295\u8D44\u987E\u95EE\u3002\u8BF7\u5206\u6790\u4EE5\u4E0B\u6301\u4ED3\u57FA\u91D1\u6570\u636E\uFF0C\u8BC4\u4F30\u6574\u4F53\u98CE\u9669\uFF0C\u5E76\u7ED9\u51FA\u5177\u4F53\u7684\u6295\u8D44\u5EFA\u8BAE\u3001\u76EE\u6807\u4ED3\u4F4D\u53CA\u64CD\u4F5C\u884C\u52A8\u3002
\u6301\u4ED3\u57FA\u91D1\u6570\u636E\uFF1A
${JSON.stringify(portfolioData, null, 2)}

\u4F60\u5F53\u524D\u7684\u6295\u8D44\u7EAA\u5F8B\u6838\u5FC3\u7B56\u7565\uFF08\u5FC5\u987B\u4F5C\u4E3A\u6240\u6709\u5EFA\u8BAE\u7684\u91CD\u8981\u53C2\u8003\u4E0E\u7EA6\u675F\uFF0C\u6240\u6709\u64CD\u4F5C\u5EFA\u8BAE\u5747\u4E0D\u5F97\u8FDD\u80CC\u8FD9\u4E9B\u7EAA\u5F8B\uFF09\uFF1A
${portfolioData.strategies && portfolioData.strategies.length > 0 ? portfolioData.strategies.map((s, i) => `${i + 1}. ${s}`).join("\n") : "\u672A\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u7B56\u7565\uFF0C\u8BF7\u57FA\u4E8E\u7A33\u5065\u3001\u7406\u6027\u7684\u5E38\u89C4\u6295\u8D44\u7EAA\u5F8B\u7ED9\u51FA\u5EFA\u8BAE"}

\u8BF7\u4E25\u683C\u6309\u7167\u4EE5\u4E0B JSON \u683C\u5F0F\u8FDB\u884C\u56DE\u590D\uFF08\u4E0D\u8981\u5305\u542B\u4EFB\u4F55 markdown \u6807\u8BB0\u3001\`\`\`json \u5757\u3001\u591A\u4F59\u6587\u5B57\u6216\u6CE8\u91CA\uFF0C\u786E\u4FDD\u5176\u4E3A\u53EF\u4EE5\u76F4\u63A5\u89E3\u6790\u7684\u7EAF JSON \u5BF9\u8C61\uFF09\uFF1A
{
  "healthScore": \u7EC4\u5408\u5065\u5EB7\u5EA6\u5206\u503C (0-100\u7684\u6570\u5B57),
  "healthText": "\u7EC4\u5408\u5065\u5EB7\u5EA6\u72B6\u6001\u8BC4\u4EF7 (\u5982\u914D\u7F6E\u6781\u4F73\u3001\u914D\u7F6E\u826F\u597D\u3001\u914D\u6BD4\u4E00\u822C\u3001\u4E9F\u5F85\u8C03\u6574\u7B49\u77ED\u8BED)",
  "healthColor": "\u72B6\u6001\u989C\u8272\u4EE3\u7801 (\u5982 #34a853 \u4EE3\u8868\u6781\u4F73/\u826F\u597D, #ff9500 \u4EE3\u8868\u4E00\u822C, #ff3b30 \u4EE3\u8868\u8F83\u5DEE)",
  "deviationText": "\u5927\u7C7B\u8D44\u4EA7\u504F\u79BB\u72B6\u6001\u8BF4\u660E (\u6839\u636E\u4F60\u5BF9\u8BE5\u7EC4\u5408\u5404\u5927\u7C7B\u504F\u79BB\u60C5\u51B5\u7684\u4E13\u4E1A\u8BC4\u4EF7)",
  "riskScore": \u8BC4\u4F30\u98CE\u9669\u5206\u503C (0-100\u7684\u6570\u5B57),
  "summary": "\u4ECA\u65E5\u64CD\u4F5C\u5EFA\u8BAE\u7684\u603B\u7ED3 (\u7ED3\u5408\u6295\u8D44\u7EAA\u5F8B\u6838\u5FC3\u7B56\u7565\uFF0C\u7528\u4E00\u53E5\u8BDD\u6982\u62EC\u4ECA\u5929\u6700\u5E94\u6267\u884C\u7684\u64CD\u4F5C\u4E0E\u7EAA\u5F8B\u63D0\u9192)",
  "suggestions": [
    {
      "fund": "\u57FA\u91D1\u540D\u79F0",
      "code": "\u57FA\u91D1\u4EE3\u7801",
      "action": "\u5EFA\u8BAE\u7684\u64CD\u4F5C\uFF1A\u5982\u6301\u6709\u3001\u52A0\u4ED3\u3001\u51CF\u4ED3\u3001\u8D4E\u56DE\u7B49",
      "reason": "\u5177\u4F53\u7684\u64CD\u4F5C\u7406\u7531 and \u5206\u6790",
      "targetPct": \u5EFA\u8BAE\u7684\u76EE\u6807\u4ED3\u4F4D\u767E\u5206\u6BD4\u6570\u503C (0-100\u7684\u6570\u5B57)
    }
  ]
}`;
  const text = await chat4(prompt, config);
  let cleanText = text.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  cleanText = cleanText.trim();
  try {
    return JSON.parse(cleanText);
  } catch (err) {
    console.error("Failed to parse Gemini AI response as JSON:", text, err);
    return {
      healthScore: 60,
      healthText: "\u9700\u8981\u8C03\u6574",
      healthColor: "#ff3b30",
      deviationText: "\u65E0\u6CD5\u83B7\u53D6 AI \u8BCA\u65AD\u7ED3\u679C\uFF0C\u663E\u793A\u672C\u5730\u4F30\u7B97",
      riskScore: 50,
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// src/services/ai/claude.ts
async function chat5(message, config) {
  const apiKey = config.apiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const model = config.model || "claude-3-5-sonnet-latest";
  if (!apiKey) {
    throw new Error("\u672A\u914D\u7F6E Claude API Key\uFF0C\u8BF7\u68C0\u67E5\u73AF\u5883\u53D8\u91CF\u6216\u4E34\u65F6\u8F93\u5165");
  }
  const isCustomBase = config.baseURL && !config.baseURL.includes("api.anthropic.com");
  if (isCustomBase) {
    const mergedConfig = {
      ...config,
      baseURL: config.baseURL,
      apiKey,
      model
    };
    return chat(message, mergedConfig);
  }
  const baseUrl = config.baseURL || "https://api.anthropic.com";
  const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const targetUrl = `${cleanBaseUrl}/v1/messages`;
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: "user", content: message }
      ]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API Response error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const textContent = data?.content?.[0]?.text;
  if (!textContent) {
    throw new Error("Claude API \u672A\u8FD4\u56DE\u6709\u6548\u7684 text \u5B57\u6BB5");
  }
  return textContent;
}
async function analyzePortfolio5(portfolioData, config) {
  const prompt = `\u4F60\u662F\u4E00\u4E2A\u4E13\u4E1A\u7684\u57FA\u91D1\u6295\u8D44\u987E\u95EE\u3002\u8BF7\u5206\u6790\u4EE5\u4E0B\u6301\u4ED3\u57FA\u91D1\u6570\u636E\uFF0C\u8BC4\u4F30\u6574\u4F53\u98CE\u9669\uFF0C\u5E76\u7ED9\u51FA\u5177\u4F53\u7684\u6295\u8D44\u5EFA\u8BAE\u3001\u76EE\u6807\u4ED3\u4F4D\u53CA\u64CD\u4F5C\u884C\u52A8\u3002
\u6301\u4ED3\u57FA\u91D1\u6570\u636E\uFF1A
${JSON.stringify(portfolioData, null, 2)}

\u4F60\u5F53\u524D\u7684\u6295\u8D44\u7EAA\u5F8B\u6838\u5FC3\u7B56\u7565\uFF08\u5FC5\u987B\u4F5C\u4E3A\u6240\u6709\u5EFA\u8BAE\u7684\u91CD\u8981\u53C2\u8003\u4E0E\u7EA6\u675F\uFF0C\u6240\u6709\u64CD\u4F5C\u5EFA\u8BAE\u5747\u4E0D\u5F97\u8FDD\u80CC\u8FD9\u4E9B\u7EAA\u5F8B\uFF09\uFF1A
${portfolioData.strategies && portfolioData.strategies.length > 0 ? portfolioData.strategies.map((s, i) => `${i + 1}. ${s}`).join("\n") : "\u672A\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u7B56\u7565\uFF0C\u8BF7\u57FA\u4E8E\u7A33\u5065\u3001\u7406\u6027\u7684\u5E38\u89C4\u6295\u8D44\u7EAA\u5F8B\u7ED9\u51FA\u5EFA\u8BAE"}

\u8BF7\u4E25\u683C\u6309\u7167\u4EE5\u4E0B JSON \u683C\u5F0F\u8FDB\u884C\u56DE\u590D\uFF08\u4E0D\u8981\u5305\u542B\u4EFB\u4F55 markdown \u6807\u8BB0\u3001\`\`\`json \u5757\u3001\u591A\u4F59\u6587\u5B57\u6216\u6CE8\u91CA\uFF0C\u786E\u4FDD\u5176\u4E3A\u53EF\u4EE5\u76F4\u63A5\u89E3\u6790\u7684\u7EAF JSON \u5BF9\u8C61\uFF09\uFF1A
{
  "healthScore": \u7EC4\u5408\u5065\u5EB7\u5EA6\u5206\u503C (0-100\u7684\u6570\u5B57),
  "healthText": "\u7EC4\u5408\u5065\u5EB7\u5EA6\u72B6\u6001\u8BC4\u4EF7 (\u5982\u914D\u7F6E\u6781\u4F73\u3001\u914D\u7F6E\u826F\u597D\u3001\u914D\u6BD4\u4E00\u822C\u3001\u4E9F\u5F85\u8C03\u6574\u7B49\u77ED\u8BED)",
  "healthColor": "\u72B6\u6001\u989C\u8272\u4EE3\u7801 (\u5982 #34a853 \u4EE3\u8868\u6781\u4F73/\u826F\u597D, #ff9500 \u4EE3\u8868\u4E00\u822C, #ff3b30 \u4EE3\u8868\u8F83\u5DEE)",
  "deviationText": "\u5927\u7C7B\u8D44\u4EA7\u504F\u79BB\u72B6\u6001\u8BF4\u660E (\u6839\u636E\u4F60\u5BF9\u8BE5\u7EC4\u5408\u5404\u5927\u7C7B\u504F\u79BB\u60C5\u51B5\u7684\u4E13\u4E1A\u8BC4\u4EF7)",
  "riskScore": \u8BC4\u4F30\u98CE\u9669\u5206\u503C (0-100\u7684\u6570\u5B57),
  "summary": "\u4ECA\u65E5\u64CD\u4F5C\u5EFA\u8BAE\u7684\u603B\u7ED3 (\u7ED3\u5408\u6295\u8D44\u7EAA\u5F8B\u6838\u5FC3\u7B56\u7565\uFF0C\u7528\u4E00\u53E5\u8BDD\u6982\u62EC\u4ECA\u5929\u6700\u5E94\u6267\u884C\u7684\u64CD\u4F5C\u4E0E\u7EAA\u5F8B\u63D0\u9192)",
  "suggestions": [
    {
      "fund": "\u57FA\u91D1\u540D\u79F0",
      "code": "\u57FA\u91D1\u4EE3\u7801",
      "action": "\u5EFA\u8BAE\u7684\u64CD\u4F5C\uFF1A\u5982\u6301\u6709\u3001\u52A0\u4ED3\u3001\u51CF\u4ED3\u3001\u8D4E\u56DE\u7B49",
      "reason": "\u5177\u4F53\u7684\u64CD\u4F5C\u7406\u7531\u548C\u5206\u6790",
      "targetPct": \u5EFA\u8BAE\u7684\u76EE\u6807\u4ED3\u4F4D\u767E\u5206\u6BD4\u6570\u503C (0-100\u7684\u6570\u5B57)
    }
  ]
}`;
  const text = await chat5(prompt, config);
  let cleanText = text.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  cleanText = cleanText.trim();
  try {
    return JSON.parse(cleanText);
  } catch (err) {
    console.error("Failed to parse Claude AI response as JSON:", text, err);
    return {
      healthScore: 60,
      healthText: "\u9700\u8981\u8C03\u6574",
      healthColor: "#ff3b30",
      deviationText: "\u65E0\u6CD5\u83B7\u53D6 AI \u8BCA\u65AD\u7ED3\u679C\uFF0C\u663E\u793A\u672C\u5730\u4F30\u7B97",
      riskScore: 50,
      summary: `\u65E0\u6CD5\u89E3\u6790 AI \u8FD4\u56DE\u7684 JSON \u6570\u636E\u3002AI \u539F\u59CB\u56DE\u590D: ${text.substring(0, 100)}...`,
      suggestions: []
    };
  }
}

// src/services/ai/index.ts
async function chat6(message, config) {
  const provider = (config.provider || "OpenAI").toLowerCase();
  switch (provider) {
    case "openai":
      return chat(message, config);
    case "deepseek":
      return chat2(message, config);
    case "moonshot kimi":
    case "kimi":
      return chat3(message, config);
    case "google gemini":
    case "gemini":
      return chat4(message, config);
    case "claude":
      return chat5(message, config);
    case "\u81EA\u5B9A\u4E49 openai compatible":
    case "custom":
      return chat(message, config);
    default:
      throw new Error(`\u672A\u77E5\u7684 AI \u670D\u52A1\u5546: ${config.provider}`);
  }
}
async function analyzePortfolio6(portfolioData, config) {
  const provider = (config.provider || "OpenAI").toLowerCase();
  switch (provider) {
    case "openai":
      return analyzePortfolio(portfolioData, config);
    case "deepseek":
      return analyzePortfolio2(portfolioData, config);
    case "moonshot kimi":
    case "kimi":
      return analyzePortfolio3(portfolioData, config);
    case "google gemini":
    case "gemini":
      return analyzePortfolio4(portfolioData, config);
    case "claude":
      return analyzePortfolio5(portfolioData, config);
    case "\u81EA\u5B9A\u4E49 openai compatible":
    case "custom":
      return analyzePortfolio(portfolioData, config);
    default:
      throw new Error(`\u672A\u77E5\u7684 AI \u670D\u52A1\u5546: ${config.provider}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  analyzePortfolio,
  chat
});
