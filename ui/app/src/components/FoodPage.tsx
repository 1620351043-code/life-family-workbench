import { useMemo, useState, type ReactNode } from "react";
import { BunnyMark } from "./BunnyMark";
import { defaultFoodHistory, foodRecipes, getFoodRecipe, type FoodIngredient, type FoodRecipe, FOOD_SOURCE_VERSION } from "../food-data";

type FoodView = "home" | "pairing" | "confirm" | "cook" | "shopping" | "search" | "history" | "preferences";
type FoodEvent = { recipeId: string; type: "selected" | "started" | "completed"; occurredAt: string };
type ShoppingItemState = { checked: boolean; owned: boolean; price: string };

export function FoodPage() {
  const [view, setView] = useState<FoodView>("home");
  const [selectedRecipe, setSelectedRecipe] = useState<FoodRecipe>(foodRecipes[0]);
  const [selectedSide, setSelectedSide] = useState<FoodRecipe | null>(foodRecipes[1]);
  const [servings, setServings] = useState(2);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [events, setEvents] = useState<FoodEvent[]>([]);
  const [shoppingStates, setShoppingStates] = useState<Record<string, ShoppingItemState>>({});
  const [financeDrafted, setFinanceDrafted] = useState(false);
  const [pairingGenerated, setPairingGenerated] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipeById = (id: string) => getFoodRecipe(id);
  const history = useMemo(() => {
    const completed = events.filter((event) => event.type === "completed").map((event, index) => ({
      id: `event-${index}`,
      recipeId: event.recipeId,
      date: event.occurredAt.slice(0, 10),
      meal: "晚餐",
      source: "完成烹饪",
      confidence: "高",
    }));
    return [...completed, ...defaultFoodHistory];
  }, [events]);
  const searchResults = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return foodRecipes;
    return foodRecipes.filter((recipe) => [recipe.title, recipe.category, recipe.subtitle, ...recipe.tags, ...recipe.ingredients.map((item) => item.name)].join(" ").toLowerCase().includes(normalized));
  }, [searchQuery]);

  const record = (recipeId: string, type: FoodEvent["type"]) => {
    setEvents((current) => [...current, { recipeId, type, occurredAt: new Date().toISOString() }]);
  };
  const chooseRecipe = (recipe: FoodRecipe) => {
    setSelectedRecipe(recipe);
    setServings(recipe.servings);
    setSelectedSide(recipe.id === foodRecipes[0].id ? foodRecipes[1] : null);
    setShoppingStates({});
    setFinanceDrafted(false);
    setShowReason(false);
    setError(null);
    setView("confirm");
  };
  const confirmMeal = () => {
    record(selectedRecipe.id, "selected");
    setView("cook");
  };
  const startCooking = () => {
    record(selectedRecipe.id, "started");
    setView("cook");
  };
  const finishCooking = () => {
    record(selectedRecipe.id, "completed");
    setView("home");
  };
  const shoppingStateFor = (ingredient: FoodIngredient): ShoppingItemState => shoppingStates[ingredient.name] ?? { checked: false, owned: Boolean(ingredient.defaultOwned), price: "" };
  const updateShoppingState = (ingredient: FoodIngredient, patch: Partial<ShoppingItemState>) => setShoppingStates((current) => {
    const fallback: ShoppingItemState = { checked: false, owned: Boolean(ingredient.defaultOwned), price: "" };
    const next: ShoppingItemState = { ...fallback, ...current[ingredient.name], ...patch };
    return { ...current, [ingredient.name]: next };
  });
  const goBack = () => {
    if (view === "shopping") setView("cook");
    else if (view === "cook") setView("confirm");
    else setView("home");
  };

  return <section className="food-page" aria-label="吃什么">
    {view === "home" && <FoodHome query={query} setQuery={setQuery} selectedRecipe={selectedRecipe} showReason={showReason} onToggleReason={() => setShowReason((current) => !current)} onChoose={chooseRecipe} onPairing={() => { setPairingGenerated(false); setView("pairing"); }} onSearch={() => { setSearchQuery(query); setView("search"); }} onHistory={() => setView("history")} onPreferences={() => setView("preferences")} onError={setError} />}
    {view === "pairing" && <PairingView generated={pairingGenerated} selectedRecipe={selectedRecipe} onBack={goBack} onGenerate={() => setPairingGenerated(true)} onChoose={chooseRecipe} />}
    {view === "confirm" && <MealConfirmView recipe={selectedRecipe} side={selectedSide} servings={servings} onBack={goBack} onServings={setServings} onToggleSide={() => setSelectedSide((current) => current ? null : foodRecipes[1])} onConfirm={confirmMeal} />}
    {view === "cook" && <HowToCookView recipe={selectedRecipe} servings={servings} onBack={goBack} onServings={setServings} onShopping={() => setView("shopping")} onStart={startCooking} onComplete={finishCooking} />}
    {view === "shopping" && <ShoppingView recipe={selectedRecipe} servings={servings} shoppingStates={shoppingStates} financeDrafted={financeDrafted} getState={shoppingStateFor} onBack={goBack} onToggle={(ingredient) => { const state = shoppingStateFor(ingredient); updateShoppingState(ingredient, ingredient.defaultOwned ? { owned: !state.owned, checked: false } : { checked: !state.checked }); }} onPrice={(ingredient, price) => updateShoppingState(ingredient, { price })} onPrepareFinance={() => setFinanceDrafted(true)} onRecipe={() => setView("cook")} />}
    {view === "search" && <SearchView query={searchQuery} setQuery={setSearchQuery} results={searchResults} onBack={goBack} onChoose={chooseRecipe} />}
    {view === "history" && <HistoryView history={history} recipeById={recipeById} onBack={goBack} onChoose={(recipe) => { setSelectedRecipe(recipe); setServings(recipe.servings); setView("cook"); }} />}
    {view === "preferences" && <PreferencesView onBack={goBack} />}
    {error && <div className="food-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>关闭</button></div>}
  </section>;
}

function FoodHome(props: { query: string; setQuery: (value: string) => void; selectedRecipe: FoodRecipe; showReason: boolean; onToggleReason: () => void; onChoose: (recipe: FoodRecipe) => void; onPairing: () => void; onSearch: () => void; onHistory: () => void; onPreferences: () => void; onError: (message: string) => void }) {
  const alternatives = foodRecipes.filter((recipe) => recipe.id !== props.selectedRecipe.id);
  return <>
    <header className="food-heading"><div><span className="eyebrow">家庭饮食 · 今日推荐</span><h1>今晚吃什么？</h1><p>先选一餐，再进入 HowToCook。</p></div><span className="food-context-pill">晚餐 · 2–3 人</span></header>
    <button type="button" className="food-search-entry" onClick={props.onSearch}><span aria-hidden="true">⌕</span><span>{props.query || "搜索菜名、食材、口味"}</span><b aria-hidden="true">›</b></button>
    <section className="food-hero-card" aria-label="今日推荐">
      <div className="food-section-heading"><div><span className="eyebrow">推荐给你</span><h2>适合今天的一餐</h2></div><button type="button" className="food-link-button" onClick={props.onPairing}>智能搭配</button></div>
      <button type="button" className="food-feature-card" onClick={() => props.onChoose(props.selectedRecipe)}>
        <RecipeArt recipe={props.selectedRecipe} large />
        <div className="food-feature-copy"><div className="food-card-topline"><span className="food-recommend-badge">小兔子推荐</span><span>›</span></div><h3>{props.selectedRecipe.title}</h3><p>{props.selectedRecipe.subtitle}</p><div className="food-meta-row"><span>◷ {props.selectedRecipe.durationMinutes} 分钟</span><span>♧ {props.selectedRecipe.servings} 人</span><span>★ {props.selectedRecipe.rating}</span></div><div className="food-reason-row"><span className="bunny-mini"><BunnyMark size={17} /></span><span>{props.selectedRecipe.reason}</span><button type="button" aria-label="查看推荐理由" onClick={(event) => { event.stopPropagation(); props.onToggleReason(); }}>i</button></div>{props.showReason && <div className="food-reason-detail">基于当前家庭已完成的烹饪记录、较少重复、晚餐时间和家庭接受度计算。这里只展示解释，不自动替你确认。</div>}</div>
      </button>
      <div className="food-alternative-label"><span>还有这些选择</span><span>{alternatives.length} 道</span></div>
      <div className="food-alternative-row">{alternatives.slice(0, 2).map((recipe) => <button type="button" className="food-mini-card" key={recipe.id} onClick={() => props.onChoose(recipe)}><RecipeArt recipe={recipe} /><strong>{recipe.title}</strong><small>{recipe.durationMinutes} 分钟 · {recipe.tags[0]}</small></button>)}</div>
    </section>
    <section className="food-quick-grid" aria-label="吃什么快捷入口">
      <button type="button" className="food-quick-card featured" onClick={props.onPairing}><span>✦</span><strong>智能搭配</strong><small>人数、时间和口味一起考虑</small><b aria-hidden="true">›</b></button>
      <button type="button" className="food-quick-card" onClick={props.onSearch}><span>⌕</span><strong>菜谱搜索</strong><small>从本地 HowToCook 菜谱库查找</small><b aria-hidden="true">›</b></button>
      <button type="button" className="food-quick-card" onClick={props.onHistory}><span>◷</span><strong>吃过什么</strong><small>系统自动采集，只读展示</small><b aria-hidden="true">›</b></button>
      <button type="button" className="food-quick-card" onClick={props.onPreferences}><span>⌁</span><strong>长期习惯</strong><small>看看小兔子学到了什么</small><b aria-hidden="true">›</b></button>
    </section>
    <section className="food-source-note"><span className="bunny-mini"><BunnyMark size={18} /></span><div><strong>来源清楚，推荐可解释</strong><p>{FOOD_SOURCE_VERSION} · AI 只解释和替换，不伪造菜谱内容。</p></div></section>
  </>;
}

function PairingView(props: { generated: boolean; selectedRecipe: FoodRecipe; onBack: () => void; onGenerate: () => void; onChoose: (recipe: FoodRecipe) => void }) {
  const [people, setPeople] = useState("2 人");
  const [portion, setPortion] = useState("适中");
  const [wish, setWish] = useState("");
  const [avoid, setAvoid] = useState("");
  return <div className="food-subpage"><FoodBack title="智能搭配" onBack={props.onBack} /><section className="food-subhero"><span className="eyebrow">小兔子帮你想一餐</span><h1>把今天的限制告诉我</h1><p>推荐只会作为建议，确认后才会进入 HowToCook。</p></section><section className="food-form-card"><FoodChoice label="人数" options={["1 人", "2 人", "3 人", "4 人"]} selected={people} onSelect={setPeople} /><FoodChoice label="餐量" options={["小份", "适中", "大份"]} selected={portion} onSelect={setPortion} /><div className="food-text-field"><label htmlFor="food-wish">今天想吃</label><input id="food-wish" value={wish} onChange={(event) => setWish(event.target.value)} placeholder="例如：下饭、清淡、少油" /></div><div className="food-text-field"><label htmlFor="food-avoid">今天避开</label><input id="food-avoid" value={avoid} onChange={(event) => setAvoid(event.target.value)} placeholder="例如：辣、海鲜、花生" /></div><button type="button" className="primary-button wide food-primary-action" onClick={props.onGenerate}>智能搭配</button><small className="food-form-footnote">已选择 {people} · {portion} · {wish.trim() || "未填写口味"}{avoid.trim() ? ` · 避开 ${avoid.trim()}` : ""}</small></section>{props.generated && <section className="food-result-card"><div className="food-section-heading"><div><span className="eyebrow">搭配结果</span><h2>今天这一餐</h2></div><button type="button" className="food-link-button" onClick={props.onGenerate}>重新生成</button></div><div className="food-result-grid"><RecipeCompact recipe={props.selectedRecipe} role="主菜" onClick={() => props.onChoose(props.selectedRecipe)} /><RecipeCompact recipe={foodRecipes[1]} role="配菜" onClick={() => props.onChoose(foodRecipes[1])} /><RecipeCompact recipe={foodRecipes[3]} role="主食" onClick={() => props.onChoose(foodRecipes[3])} /></div><button type="button" className="primary-button wide" onClick={() => props.onChoose(props.selectedRecipe)}>进入选择确认</button></section>}</div>;
}

function MealConfirmView(props: { recipe: FoodRecipe; side: FoodRecipe | null; servings: number; onBack: () => void; onServings: (value: number) => void; onToggleSide: () => void; onConfirm: () => void }) {
  return <div className="food-subpage"><FoodBack title="确认这一餐" onBack={props.onBack} /><section className="food-subhero compact"><span className="eyebrow">选择确认</span><h1>这份菜单合适吗？</h1><p>确认后进入 HowToCook，份数和来源会一起带入。</p></section><section className="food-confirm-card"><div className="food-confirm-row selected"><RecipeArt recipe={props.recipe} /><div><strong>{props.recipe.title}</strong><small>主菜 · {props.recipe.durationMinutes} 分钟 · {props.recipe.servings} 人</small></div><span>✓</span></div><button type="button" className={`food-confirm-row ${props.side ? "selected" : "optional"}`} onClick={props.onToggleSide}><RecipeArt recipe={foodRecipes[1]} /><div><strong>{foodRecipes[1].title}</strong><small>配菜 · {foodRecipes[1].durationMinutes} 分钟 · 与主菜采购重叠少</small></div><span>{props.side ? "✓" : "+"}</span></button><div className="food-serving-control"><div><strong>这餐几个人吃？</strong><small>食材数量会同步换算</small></div><div className="stepper"><button type="button" aria-label="减少份数" disabled={props.servings <= 1} onClick={() => props.onServings(Math.max(1, props.servings - 1))}>−</button><b>{props.servings} 人</b><button type="button" aria-label="增加份数" disabled={props.servings >= 8} onClick={() => props.onServings(Math.min(8, props.servings + 1))}>＋</button></div></div><div className="food-confirm-notice">已选 1 道主菜{props.side ? " · 1 道配菜" : ""} · 推荐理由和来源会保留。</div><button type="button" className="primary-button wide" onClick={props.onConfirm}>确认并进入 HowToCook</button></section></div>;
}

function HowToCookView(props: { recipe: FoodRecipe; servings: number; onBack: () => void; onServings: (value: number) => void; onShopping: () => void; onStart: () => void; onComplete: () => void }) {
  const [tab, setTab] = useState<"ingredients" | "steps">("ingredients");
  const [completedStep, setCompletedStep] = useState(0);
  const scale = props.servings / props.recipe.servings;
  return <div className="food-subpage cook-page"><FoodBack title="HowToCook" onBack={props.onBack} right={<button type="button" className="food-icon-action" aria-label="收藏菜谱">♡</button>} /><section className="cook-header"><RecipeArt recipe={props.recipe} large /><div className="cook-header-copy"><span className="food-source-badge">本地审核发布包</span><h1>{props.recipe.title}</h1><p>{props.recipe.summary}</p><div className="food-meta-row"><span>◷ {props.recipe.durationMinutes} 分钟</span><span>♧ {props.servings} 人</span><span>★ {props.recipe.rating}</span></div></div></section><div className="food-tabs" role="tablist" aria-label="菜谱内容"><button type="button" role="tab" aria-selected={tab === "ingredients"} className={tab === "ingredients" ? "selected" : ""} onClick={() => setTab("ingredients")}>食材与工具</button><button type="button" role="tab" aria-selected={tab === "steps"} className={tab === "steps" ? "selected" : ""} onClick={() => setTab("steps")}>烹饪步骤</button></div>{tab === "ingredients" ? <><section className="cook-section"><div className="food-section-heading"><div><span className="eyebrow">按份数换算</span><h2>食材</h2></div><ServingControl servings={props.servings} onChange={props.onServings} /></div><div className="ingredient-list">{props.recipe.ingredients.map((ingredient) => <IngredientRow key={ingredient.name} ingredient={ingredient} scale={scale} />)}</div></section><section className="cook-section"><div className="food-section-heading"><div><span className="eyebrow">准备好再开火</span><h2>需要的工具</h2></div></div><div className="tool-chip-list">{props.recipe.tools.map((tool) => <span key={tool}>{tool}</span>)}</div></section></> : <section className="cook-section step-section"><div className="food-section-heading"><div><span className="eyebrow">原始步骤 · {completedStep}/{props.recipe.steps.length}</span><h2>跟着做就好</h2></div><button type="button" className="food-link-button" onClick={props.onStart}>专注模式</button></div><div className="steps-list">{props.recipe.steps.map((step, index) => <button type="button" className={`step-row ${index < completedStep ? "done" : ""}`} key={step} onClick={() => setCompletedStep((current) => index < current ? index : index + 1)}><span>{index < completedStep ? "✓" : index + 1}</span><p>{step}</p><b>›</b></button>)}</div><div className="food-ai-note"><BunnyMark size={20} /><span>小兔子可以解释当前步骤，但不会改写原始菜谱。</span></div></section>}<div className="cook-bottom-actions"><button type="button" className="secondary-button" onClick={props.onShopping}>生成采购清单</button><button type="button" className="primary-button" onClick={props.onComplete}>完成烹饪</button></div></div>;
}

function ShoppingView(props: { recipe: FoodRecipe; servings: number; shoppingStates: Record<string, ShoppingItemState>; financeDrafted: boolean; getState: (ingredient: FoodIngredient) => ShoppingItemState; onBack: () => void; onToggle: (ingredient: FoodIngredient) => void; onPrice: (ingredient: FoodIngredient, price: string) => void; onPrepareFinance: () => void; onRecipe: () => void }) {
  const scale = props.servings / props.recipe.servings;
  const categoryOrder: Record<FoodIngredient["category"], number> = { "肉蛋奶": 1, "蔬菜": 2, "主食": 3, "调料": 4, "其他": 5 };
  const ordered = props.recipe.ingredients.map((ingredient) => ({ ingredient, state: props.getState(ingredient) })).sort((a, b) => {
    const aSettled = a.state.owned || a.state.checked;
    const bSettled = b.state.owned || b.state.checked;
    if (aSettled !== bSettled) return aSettled ? 1 : -1;
    return categoryOrder[a.ingredient.category] - categoryOrder[b.ingredient.category];
  });
  const active = ordered.filter(({ state }) => !state.owned && !state.checked);
  const settled = ordered.filter(({ state }) => state.owned || state.checked);
  const settledCount = settled.length;
  const pricedItems = props.recipe.ingredients.filter((ingredient) => Number(props.getState(ingredient).price) > 0);
  const totalCost = pricedItems.reduce((sum, ingredient) => sum + Number(props.getState(ingredient).price), 0);
  const costDisplay = totalCost.toFixed(2);
  const renderItem = ({ ingredient, state }: { ingredient: FoodIngredient; state: ShoppingItemState }) => {
    const isSettled = state.owned || state.checked;
    const checkboxLabel = ingredient.defaultOwned
      ? (state.owned ? `${ingredient.name}已有，点击改为待购买` : `${ingredient.name}加入采购`)
      : (state.checked ? `${ingredient.name}已准备，点击移回待购买` : `${ingredient.name}标记为已准备`);
    return <div className={`shopping-item ${state.checked ? "checked" : ""} ${state.owned ? "owned" : ""}`} key={ingredient.name}>
      <button type="button" className="shopping-checkbox" aria-label={checkboxLabel} aria-pressed={isSettled} onClick={() => props.onToggle(ingredient)}>{state.owned ? "有" : state.checked ? "✓" : ""}</button>
      <span><strong>{ingredient.name}</strong><small>{ingredient.optional ? "可选 · " : ""}<span className="shopping-category">{ingredient.category}</span> · {ingredient.defaultOwned ? (state.owned ? "默认已有提醒" : "加入采购") : (state.checked ? "已准备" : "待购买")} · 来源：{props.recipe.title}</small></span>
      <label className="shopping-price"><span>¥</span><input type="number" min="0" step="0.01" inputMode="decimal" value={state.price} placeholder={state.owned ? "已有" : "价格"} aria-label={`${ingredient.name}实际价格`} onChange={(event) => props.onPrice(ingredient, event.target.value)} /></label>
    </div>;
  };
  return <div className="food-subpage shopping-page"><FoodBack title="采购清单" onBack={props.onBack} right={<button type="button" className="food-icon-action" aria-label="分享采购清单">□</button>} /><section className="shopping-hero"><span className="eyebrow">来自 1 道菜谱 · {props.servings} 人份</span><h1>把这顿饭带回家</h1><p>同名食材会自动合并，来源始终保留。</p><div className="shopping-progress"><span style={{ width: `${(settledCount / props.recipe.ingredients.length) * 100}%` }} /><small>{settledCount}/{props.recipe.ingredients.length} 项已处理</small></div></section><section className="shopping-section"><div className="food-section-heading"><div><span className="eyebrow">食材 · 可填实际价格</span><h2>需要购买</h2></div><button type="button" className="food-link-button" onClick={props.onRecipe}>查看菜谱</button></div><div className="shopping-list"><div className="shopping-group-label">待购买 · 勾选后自动置底</div>{active.length ? active.map(renderItem) : <div className="shopping-empty-line">采购项已全部处理，价格仍可继续补充。</div>}{settled.length > 0 && <><div className="shopping-group-label settled">已有 / 已准备 · 自动置底</div>{settled.map(renderItem)}</>}</div></section><section className="shopping-finance-card"><div><span className="eyebrow">真实成本</span><h2>¥ {costDisplay}</h2><p>填写每项商品的实际成交价，后续可作为家庭餐饮成本导入财务。</p></div><button type="button" className="secondary-button" disabled={pricedItems.length === 0} onClick={props.onPrepareFinance}>{props.financeDrafted ? "已生成成本草稿" : "生成财务成本草稿"}</button>{props.financeDrafted && <small className="shopping-finance-status">已整理 {pricedItems.length} 项价格；正式写入账本前仍需确认账户和分类。</small>}</section><section className="shopping-source"><span>↗</span><div><strong>来源可回溯</strong><p>这份清单由「{props.recipe.title}」生成，价格和状态只影响当前清单。</p></div></section></div>;
}

function SearchView(props: { query: string; setQuery: (value: string) => void; results: FoodRecipe[]; onBack: () => void; onChoose: (recipe: FoodRecipe) => void }) {
  const [filter, setFilter] = useState("全部");
  const filteredResults = props.results.filter((recipe) => filter === "全部" || (filter === "家常菜" ? recipe.category === filter : filter === "一锅出" ? recipe.tags.includes(filter) : recipe.tags.includes(filter)));
  return <div className="food-subpage search-page"><FoodBack title="菜谱搜索" onBack={props.onBack} /><div className="food-search-field"><span>⌕</span><input autoFocus value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="菜名、食材、口味、耗时" aria-label="搜索菜谱" /><button type="button" aria-label="清空搜索" onClick={() => props.setQuery("")}>×</button></div><div className="food-filter-row">{["全部", "快手", "家常菜", "一锅出"].map((item) => <button type="button" className={filter === item ? "selected" : ""} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div><section className="search-results"><div className="food-section-heading"><div><span className="eyebrow">HowToCook 菜谱库</span><h2>{props.query ? `找到 ${filteredResults.length} 道菜` : "最近适合家庭的菜"}</h2></div></div>{filteredResults.length === 0 ? <div className="food-empty-state"><span>⌕</span><strong>没有找到匹配菜谱</strong><p>换一个食材或口味试试，搜索不会生成不存在的菜谱。</p></div> : <div className="search-result-list">{filteredResults.map((recipe) => <button type="button" className="search-result-card" key={recipe.id} onClick={() => props.onChoose(recipe)}><RecipeArt recipe={recipe} /><span><strong>{recipe.title}</strong><small>{recipe.category} · {recipe.durationMinutes} 分钟 · ★ {recipe.rating}</small><em>{recipe.tags.join(" · ")}</em></span><b>›</b></button>)}</div>}</section></div>;
}

function HistoryView(props: { history: ReadonlyArray<{ id: string; recipeId: string; date: string; meal: string; source: string; confidence: string }>; recipeById: (id: string) => FoodRecipe; onBack: () => void; onChoose: (recipe: FoodRecipe) => void }) {
  const [meal, setMeal] = useState("全部");
  const filteredHistory = props.history.filter((item) => meal === "全部" || item.meal === meal);
  return <div className="food-subpage history-page"><FoodBack title="吃过什么" onBack={props.onBack} /><section className="food-subhero compact"><span className="eyebrow">自动采集 · 只读展示</span><h1>吃过什么</h1><p>只有完成烹饪流程才会记录，不提供手动补录。</p></section><div className="food-filter-row history-filters">{["全部", "早餐", "午餐", "晚餐"].map((item) => <button type="button" className={meal === item ? "selected" : ""} key={item} onClick={() => setMeal(item)}>{item}</button>)}</div><section className="history-list">{filteredHistory.map((item) => { const recipe = props.recipeById(item.recipeId); return <button type="button" className="history-row" key={item.id} onClick={() => props.onChoose(recipe)}><RecipeArt recipe={recipe} /><span><strong>{recipe.title}</strong><small>{item.date} · {item.meal} · {item.source}</small><em>{item.confidence}置信 · 查看 HowToCook</em></span><b>›</b></button>; })}</section>{filteredHistory.length === 0 && <div className="food-empty-state small"><strong>这个餐次还没有高置信记录</strong><p>完成烹饪后，系统会自动沉淀到这里。</p></div>}<section className="food-readonly-note"><span>⌁</span><p>浏览、收藏和选择不会直接判定为“吃过”，只有完成烹饪事件才会进入这里。</p></section></div>;
}

function PreferencesView(props: { onBack: () => void }) {
  return <div className="food-subpage preferences-page"><FoodBack title="长期习惯" onBack={props.onBack} /><section className="preference-hero"><span className="bunny-mini"><BunnyMark size={22} /></span><span className="eyebrow">小兔子正在学习</span><h1>你们更常选择什么？</h1><p>这里是自动从家庭行为中聚合出的展示，不是手动偏好设置。</p></section><section className="preference-card"><div className="food-section-heading"><div><span className="eyebrow">过去 30 天 · 28 次高置信行为</span><h2>家庭口味画像</h2></div><span className="preference-status">已更新</span></div><div className="preference-tag-list"><span>家常菜 · 12 次</span><span>少油 · 9 次</span><span>一锅出 · 7 次</span><span>30 分钟内 · 18 次</span><span>清淡配菜 · 8 次</span></div></section><section className="preference-card"><div className="food-section-heading"><div><span className="eyebrow">为什么这样判断</span><h2>推荐会参考这些信号</h2></div></div><div className="preference-signal-list"><div><span>↗</span><p><strong>最近较少重复</strong><small>最近 7 天没有重复主菜</small></p></div><div><span>◷</span><p><strong>当前时间</strong><small>今晚可用时间约 30 分钟</small></p></div><div><span>♡</span><p><strong>家庭接受度</strong><small>历史完成率和主动选择共同计算</small></p></div></div></section><section className="food-ai-note"><BunnyMark size={20} /><span>你可以随时让小兔子解释某一条推荐，但不会自动修改家庭偏好。</span></section></div>;
}

function FoodBack(props: { title: string; onBack: () => void; right?: ReactNode }) {
  return <div className="food-back"><button type="button" aria-label={`返回${props.title === "吃过什么" ? "吃什么" : "上一级"}`} onClick={props.onBack}>‹</button><strong>{props.title}</strong><span>{props.right ?? <span className="food-back-placeholder" />}</span></div>;
}

function RecipeArt({ recipe, large = false }: { recipe: FoodRecipe; large?: boolean }) {
  return <div className={`recipe-art ${recipe.palette}${large ? " large" : ""}`} aria-hidden="true"><span className="recipe-art-glow" /><span className="recipe-art-emoji">{recipe.icon}</span><small>HowToCook</small></div>;
}

function RecipeCompact({ recipe, role, onClick }: { recipe: FoodRecipe; role: string; onClick: () => void }) {
  return <button type="button" className="food-result-recipe" onClick={onClick}><RecipeArt recipe={recipe} /><span><small>{role}</small><strong>{recipe.title}</strong><em>{recipe.durationMinutes} 分钟 · {recipe.servings} 人</em></span><b>›</b></button>;
}

function FoodChoice({ label, options, selected, onSelect }: { label: string; options: string[]; selected: string; onSelect: (value: string) => void }) {
  return <div className="food-choice"><label>{label}</label><div>{options.map((option) => <button type="button" key={option} className={option === selected ? "selected" : ""} aria-pressed={option === selected} onClick={() => onSelect(option)}>{option}</button>)}</div></div>;
}

function ServingControl({ servings, onChange }: { servings: number; onChange: (value: number) => void }) {
  return <div className="stepper compact-stepper"><button type="button" aria-label="减少份数" disabled={servings <= 1} onClick={() => onChange(Math.max(1, servings - 1))}>−</button><b>{servings} 人</b><button type="button" aria-label="增加份数" disabled={servings >= 8} onClick={() => onChange(Math.min(8, servings + 1))}>＋</button></div>;
}

function IngredientRow({ ingredient, scale }: { ingredient: FoodIngredient; scale: number }) {
  return <div className="ingredient-row"><span className="ingredient-dot" /><span><strong>{ingredient.name}</strong>{ingredient.optional && <small>可选</small>}</span><b>{formatQuantity(ingredient, scale)}</b></div>;
}

function formatQuantity(ingredient: FoodIngredient, scale: number) {
  const value = ingredient.quantity * scale;
  const display = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  return `${display}${ingredient.unit}`;
}
