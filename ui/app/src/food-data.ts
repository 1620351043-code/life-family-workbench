export type FoodIngredient = { name: string; quantity: number; unit: string; category: "肉蛋奶" | "蔬菜" | "主食" | "调料" | "其他"; optional?: boolean; defaultOwned?: boolean };
export type FoodRecipe = {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  durationMinutes: number;
  servings: number;
  difficulty: "简单" | "适中";
  rating: string;
  tags: string[];
  palette: "tomato" | "green" | "gold" | "purple";
  icon: string;
  reason: string;
  summary: string;
  ingredients: FoodIngredient[];
  tools: string[];
  steps: string[];
  sourceVersion: string;
};

// This is an explicit UI-slice snapshot. It will be replaced by the normalized
// HowToCook publish package when the upstream parser/data contract is connected.
export const FOOD_SOURCE_VERSION = "HowToCook 本地发布包 · UI 切片样本";

export const foodRecipes: FoodRecipe[] = [
  {
    id: "tomato-beef-stew",
    title: "西红柿牛腩",
    subtitle: "酸甜浓郁的一锅家常菜",
    category: "家常菜",
    durationMinutes: 25,
    servings: 2,
    difficulty: "适中",
    rating: "4.8",
    tags: ["下饭", "一锅出", "家庭接受度高"],
    palette: "tomato",
    icon: "🍅",
    reason: "最近较少重复，适合今晚的时间，也能和家里的米饭一起完成一餐。",
    summary: "牛腩软烂、汤汁酸甜，适合全家一起吃。原始步骤来自当前本地发布包。",
    ingredients: [
      { name: "牛腩", quantity: 500, unit: "g", category: "肉蛋奶" },
      { name: "西红柿", quantity: 3, unit: "个", category: "蔬菜" },
      { name: "土豆", quantity: 2, unit: "个", category: "蔬菜" },
      { name: "洋葱", quantity: 1, unit: "个", category: "蔬菜" },
      { name: "生姜", quantity: 3, unit: "片", category: "调料", defaultOwned: true },
      { name: "生抽", quantity: 2, unit: "汤匙", category: "调料", defaultOwned: true },
    ],
    tools: ["炒锅", "汤锅", "菜刀", "砧板"],
    steps: [
      "牛腩切块，冷水下锅焯水，捞出后冲洗干净。",
      "锅中少油，放入洋葱和生姜炒香，再加入牛腩翻炒。",
      "放入西红柿、土豆和调味料，加入足量清水。",
      "小火炖至牛腩软烂，最后根据口味调整咸淡。",
    ],
    sourceVersion: FOOD_SOURCE_VERSION,
  },
  {
    id: "garlic-broccoli",
    title: "清炒时蔬",
    subtitle: "15 分钟完成的轻盈配菜",
    category: "快手菜",
    durationMinutes: 15,
    servings: 2,
    difficulty: "简单",
    rating: "4.6",
    tags: ["少油", "快手", "配菜"],
    palette: "green",
    icon: "🥦",
    reason: "和西红柿牛腩的食材重叠少，颜色和口感都能让这一餐更平衡。",
    summary: "保留蔬菜清脆口感，适合作为主菜旁边的快速配菜。",
    ingredients: [
      { name: "西兰花", quantity: 300, unit: "g", category: "蔬菜" },
      { name: "蒜", quantity: 3, unit: "瓣", category: "调料", defaultOwned: true },
      { name: "胡萝卜", quantity: 0.5, unit: "根", category: "蔬菜", optional: true },
      { name: "食用油", quantity: 1, unit: "汤匙", category: "调料", defaultOwned: true },
    ],
    tools: ["炒锅", "菜刀", "砧板"],
    steps: [
      "西兰花切成小朵，清洗后沥干；蒜切片。",
      "锅中烧水，西兰花快速焯水后捞出。",
      "热锅少油，放入蒜片和蔬菜快速翻炒。",
    ],
    sourceVersion: FOOD_SOURCE_VERSION,
  },
  {
    id: "three-cup-chicken",
    title: "三杯鸡",
    subtitle: "香气饱满的周末主菜",
    category: "下饭菜",
    durationMinutes: 40,
    servings: 3,
    difficulty: "适中",
    rating: "4.7",
    tags: ["周末", "浓香", "主菜"],
    palette: "gold",
    icon: "🍗",
    reason: "家庭历史中偏爱浓香主菜，今天有足够时间慢慢收汁。",
    summary: "鸡肉吸收酱香后口感饱满，适合周末或多人共享。",
    ingredients: [
      { name: "鸡腿肉", quantity: 600, unit: "g", category: "肉蛋奶" },
      { name: "九层塔", quantity: 20, unit: "g", category: "蔬菜" },
      { name: "生姜", quantity: 6, unit: "片", category: "调料", defaultOwned: true },
      { name: "米酒", quantity: 60, unit: "ml", category: "调料", defaultOwned: true },
      { name: "生抽", quantity: 30, unit: "ml", category: "调料", defaultOwned: true },
    ],
    tools: ["炒锅", "菜刀", "砧板"],
    steps: [
      "鸡腿肉切块，用厨房纸吸干表面水分。",
      "姜片下锅煸香，加入鸡肉煎至表面微黄。",
      "加入米酒和生抽，转小火收汁。",
      "关火前加入九层塔拌匀即可。",
    ],
    sourceVersion: FOOD_SOURCE_VERSION,
  },
  {
    id: "mushroom-rice",
    title: "香菇鸡肉焖饭",
    subtitle: "一锅完成，适合忙碌工作日",
    category: "一锅饭",
    durationMinutes: 35,
    servings: 2,
    difficulty: "简单",
    rating: "4.5",
    tags: ["一锅出", "工作日", "少洗锅"],
    palette: "purple",
    icon: "🍚",
    reason: "今天可用时间有限，一锅完成能减少准备和收拾的负担。",
    summary: "米饭吸收香菇和鸡肉的鲜味，准备简单，适合工作日晚餐。",
    ingredients: [
      { name: "大米", quantity: 200, unit: "g", category: "主食", defaultOwned: true },
      { name: "鸡腿肉", quantity: 250, unit: "g", category: "肉蛋奶" },
      { name: "干香菇", quantity: 5, unit: "朵", category: "蔬菜" },
      { name: "胡萝卜", quantity: 1, unit: "根", category: "蔬菜" },
      { name: "玉米粒", quantity: 80, unit: "g", category: "蔬菜", optional: true },
    ],
    tools: ["电饭煲", "炒锅", "菜刀"],
    steps: [
      "大米淘洗后浸泡，香菇提前泡发并切片。",
      "鸡肉和香菇下锅炒香，加入胡萝卜和调味料。",
      "将炒好的食材与大米一起放入电饭煲，加水焖熟。",
      "开盖后拌匀，静置 5 分钟再盛出。",
    ],
    sourceVersion: FOOD_SOURCE_VERSION,
  },
];

export const defaultFoodHistory = [
  { id: "history-1", recipeId: "tomato-beef-stew", date: "2026-08-20", meal: "晚餐", source: "完成烹饪", confidence: "高" },
  { id: "history-2", recipeId: "mushroom-rice", date: "2026-08-18", meal: "晚餐", source: "完成烹饪", confidence: "高" },
  { id: "history-3", recipeId: "garlic-broccoli", date: "2026-08-16", meal: "午餐", source: "完成烹饪", confidence: "高" },
] as const;

export function getFoodRecipe(recipeId: string) {
  return foodRecipes.find((recipe) => recipe.id === recipeId) ?? foodRecipes[0];
}
