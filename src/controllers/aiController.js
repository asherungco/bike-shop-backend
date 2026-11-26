
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const PRIMARY_MODEL = env.GEMINI_MODEL || "gemini-3.8-flash";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new Error("Gemini returned unreadable recommendation data.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function getGeneratedText(result) {
  if (typeof result.output_text === "string" && result.output_text.trim()) {
    return result.output_text;
  }

  const steps = Array.isArray(result.steps) ? result.steps : [];

  return steps
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text || "")
    .join("");
}

async function requestGemini(model, prompt) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(GEMINI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          model,
          input: prompt,
          store: false
        })
      });

      const raw = await response.text();

      let result;

      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("Gemini returned an unreadable API response.");
      }

      if (!response.ok) {
        const error = new Error(
          result?.error?.message || `Gemini API error: ${response.status}`
        );

        error.status = response.status;
        throw error;
      }

      const generatedText = getGeneratedText(result);

      if (!generatedText) {
        throw new Error("Gemini did not return recommendation text.");
      }

      return generatedText;
    } catch (error) {
      lastError = error;

      const retryable =
        !error.status ||
        [429, 500, 502, 503, 504].includes(error.status);

      if (!retryable || attempt === 2) {
        break;
      }

      console.warn(
        `Gemini ${model} temporarily unavailable. Retrying attempt ${attempt + 1}.`
      );

      await sleep(1500);
    }
  }

  throw lastError;
}

function getProductDetails(product) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    kind: product.kind,
    price_centavos: Number(product.price_centavos),
    stock_qty: Number(product.stock_qty),
    image_url: product.image_url
  };
}

const useCases = [
  {
    label: "Daily commuting",
    weight: 10,
    triggers: [
      "commut", "school", "work", "office", "daily ride",
      "city ride", "urban", "transport", "travel to work"
    ],
    productKeywords: [
      "commuter", "city", "urban", "hybrid", "comfort",
      "commuting", "trekking"
    ]
  },
  {
    label: "Long-distance riding",
    weight: 9,
    triggers: [
      "long ride", "long distance", "endurance", "road trip",
      "distance riding", "long journey", "long rides"
    ],
    productKeywords: [
      "endurance", "road", "touring", "gravel",
      "distance", "road bike"
    ]
  },
  {
    label: "Mountain biking",
    weight: 10,
    triggers: [
      "mountain", "mtb", "trail", "off road",
      "off-road", "rough terrain", "mountain trail"
    ],
    productKeywords: [
      "mountain", "mtb", "trail", "hardtail",
      "suspension", "off road"
    ]
  },
  {
    label: "Casual riding",
    weight: 7,
    triggers: [
      "casual", "leisure", "relax", "recreation",
      "weekend ride", "park"
    ],
    productKeywords: [
      "comfort", "cruiser", "city", "leisure",
      "recreational"
    ]
  },
  {
    label: "Speed and performance",
    weight: 9,
    triggers: [
      "speed", "fast", "racing", "race",
      "performance", "competitive", "fitness"
    ],
    productKeywords: [
      "road", "racing", "performance", "speed",
      "aero", "road bike"
    ]
  },
  {
    label: "Youth riding",
    weight: 10,
    triggers: [
      "child", "children", "kid", "kids",
      "youth", "young rider"
    ],
    productKeywords: [
      "youth", "kids", "junior", "child"
    ]
  }
];

function buildLocalRecommendations(candidates, needs) {
  const customerNeeds = String(needs || "").toLowerCase();

  const requestedUseCases = useCases.filter((useCase) =>
    useCase.triggers.some((trigger) =>
      customerNeeds.includes(trigger)
    )
  );

  const searchWords = customerNeeds.match(/[a-z0-9]+/g) || [];

  const ignoredWords = new Set([
    "the", "and", "for", "with", "that", "this", "from",
    "have", "need", "want", "looking", "something", "good",
    "best", "bike", "bicycle", "product", "please", "a",
    "an", "to", "of", "in", "on", "is", "it", "my",
    "i", "me", "we", "our", "can", "be", "or", "occasional"
  ]);

  const usefulWords = searchWords.filter(
    (word) => word.length > 2 && !ignoredWords.has(word)
  );

  const rankedProducts = candidates.map((product) => {
    const searchableText = [
      product.name,
      product.description,
      product.kind
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    let score = 0;
    const matchedUseCases = [];

    for (const useCase of requestedUseCases) {
      const matched = useCase.productKeywords.some((keyword) =>
        searchableText.includes(keyword)
      );

      if (matched) {
        score += useCase.weight;
        matchedUseCases.push(useCase.label);
      }
    }

    const matchedWords = [
      ...new Set(
        usefulWords.filter((word) => searchableText.includes(word))
      )
    ];

    score += matchedWords.length * 2;

    return {
      product,
      score,
      matchedUseCases,
      matchedWords
    };
  });

  rankedProducts.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return (
      Number(a.product.price_centavos) -
      Number(b.product.price_centavos)
    );
  });

  return rankedProducts.slice(0, 3).map((item, index) => {
    const { product, score, matchedUseCases, matchedWords } = item;

    const description = String(product.description || "").toLowerCase();

    let reason;

    if (matchedUseCases.length > 0) {
      reason = `Suitable for ${matchedUseCases.join(" and ").toLowerCase()}.`;
    } else if (matchedWords.length > 0) {
      reason = `Matches your request based on ${matchedWords.join(", ")}.`;
    } else if (description.includes("hydraulic disc brakes")) {
      reason =
        "An alternative featuring hydraulic disc brakes and a performance-focused setup.";
    } else if (description.includes("mechanical disc brakes")) {
      reason =
        "A more affordable alternative featuring mechanical disc brakes.";
    } else if (description.includes("commuter")) {
      reason =
        "An alternative designed for everyday commuting.";
    } else {
      reason =
        "Another available option within your selected filters.";
    }

    return {
      product: getProductDetails(product),
      reason,
      match:
        score === 0
          ? "alternative"
          : index === 0
            ? "best_match"
            : "good_match"
    };
  });
}

function buildGeminiRecommendations(generatedText, candidates) {
  const parsed = extractJson(generatedText);

  if (!Array.isArray(parsed.recommendations)) {
    throw new Error("Gemini returned an invalid recommendations list.");
  }

  const productMap = new Map(
    candidates.map((product) => [product.id, product])
  );

  return parsed.recommendations
    .slice(0, 3)
    .filter((item) => productMap.has(item.product_id))
    .map((item) => {
      const product = productMap.get(item.product_id);

      return {
        product: getProductDetails(product),
        reason: String(item.reason || "Matches your stated needs."),
        match: String(item.match || "recommended")
      };
    });
}

export const getRecommendations = async (req, res) => {
  const { needs, budget_centavos, preferred_kind } = req.validatedBody;

  const { data: products, error } = await supabase
    .from("products")
    .select(
      "id, sku, name, description, kind, price_centavos, stock_qty, image_url"
    )
    .eq("is_active", true)
    .gt("stock_qty", 0)
    .order("name", { ascending: true });

  if (error) {
    console.error("Product inventory error:", error);
    throw new AppError(500, "Could not load available products.");
  }

  let candidates = products || [];

  if (Number.isInteger(budget_centavos)) {
    candidates = candidates.filter(
      (product) => Number(product.price_centavos) <= budget_centavos
    );
  }

  if (preferred_kind) {
    candidates = candidates.filter(
      (product) => product.kind === preferred_kind
    );
  }

  if (candidates.length === 0) {
    return res.status(200).json({
      success: true,
      message: "No available products match those filters.",
      data: {
        recommendations: [],
        recommendation_source: "inventory"
      }
    });
  }

  const productContext = candidates.map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description || "",
    kind: product.kind,
    price_centavos: Number(product.price_centavos),
    stock_qty: Number(product.stock_qty)
  }));

  const prompt = [
    "You are a product recommendation assistant for a bicycle shop.",
    "Recommend up to 3 products only from the supplied inventory.",
    "Do not invent products, prices, specifications, or stock.",
    "Match the customer's needs and budget.",
    "Explain each recommendation briefly.",
    "If none are suitable, return an empty recommendations array.",
    "Return only valid JSON in this exact shape:",
    '{"recommendations":[{"product_id":"UUID","reason":"short reason","match":"best_match"}]}',
    `Customer needs: ${needs}`,
    `Budget in centavos: ${budget_centavos ?? "not specified"}`,
    `Preferred product kind: ${preferred_kind ?? "no preference"}`,
    `Available inventory: ${JSON.stringify(productContext)}`
  ].join("\n");

  let recommendations;
  let recommendationSource;

  try {
    const generatedText = await requestGemini(PRIMARY_MODEL, prompt);

    recommendations = buildGeminiRecommendations(
      generatedText,
      candidates
    );

    if (recommendations.length === 0) {
      throw new Error("Gemini returned no valid inventory recommendations.");
    }

    recommendationSource = "gemini";
  } catch (error) {
    console.error(
      "Gemini recommendation failed. Using local recommendation engine:",
      error.message
    );

    recommendations = buildLocalRecommendations(candidates, needs);
    recommendationSource = "local_fallback";
  }

  return res.status(200).json({
    success: true,
    message:
      recommendationSource === "local_fallback"
        ? "Recommendations generated using the local recommendation engine."
        : "AI recommendations generated successfully.",
    data: {
      recommendations,
      recommendation_source: recommendationSource
    }
  });
};
