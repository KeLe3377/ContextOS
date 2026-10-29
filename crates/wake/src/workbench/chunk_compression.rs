use super::*;

use gpui_component::checkbox::Checkbox;

#[derive(Clone, Debug)]
pub(super) struct ConversationTurn {
    pub(super) number: usize,
    pub(super) start_seq: i64,
    pub(super) end_seq: i64,
    pub(super) messages: Vec<TranscriptMessage>,
}

#[derive(Clone, Debug)]
pub(super) struct CompressedTurn {
    pub(super) number: usize,
    pub(super) start_seq: i64,
    pub(super) end_seq: i64,
    pub(super) display_content: String,
    pub(super) markdown: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TurnBlock {
    pub(super) turn_numbers: Vec<usize>,
    pub(super) start_seq: i64,
    pub(super) end_seq: i64,
    pub(super) markdown: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ChunkPlan {
    pub(super) blocks: Vec<TurnBlock>,
    pub(super) oversized_turns: Vec<usize>,
}

pub(super) fn group_complete_turns(messages: &[TranscriptMessage]) -> Vec<ConversationTurn> {
    let mut groups: Vec<Vec<TranscriptMessage>> = Vec::new();
    let mut current = Vec::new();
    let mut current_has_user = false;

    for message in messages {
        if message.role == MessageRole::User && current_has_user {
            groups.push(std::mem::take(&mut current));
            current_has_user = false;
        }
        if message.role == MessageRole::User {
            current_has_user = true;
        }
        current.push(message.clone());
    }
    if !current.is_empty() {
        groups.push(current);
    }

    groups
        .into_iter()
        .enumerate()
        .filter_map(|(index, messages)| {
            Some(ConversationTurn {
                number: index + 1,
                start_seq: messages.first()?.seq,
                end_seq: messages.last()?.seq,
                messages,
            })
        })
        .collect()
}

pub(super) fn build_compressed_turns(
    turns: &[ConversationTurn],
    mut compact: impl FnMut(&str) -> anyhow::Result<String>,
) -> anyhow::Result<Vec<CompressedTurn>> {
    turns
        .iter()
        .map(|turn| {
            let fragment = wake_core::services::exporter::messages_to_markdown(&turn.messages);
            let markdown = compact(&fragment)?;
            Ok(CompressedTurn {
                number: turn.number,
                start_seq: turn.start_seq,
                end_seq: turn.end_seq,
                display_content: turn_display_content(turn),
                markdown,
            })
        })
        .collect()
}

fn turn_display_content(turn: &ConversationTurn) -> String {
    let content = turn
        .messages
        .iter()
        .filter_map(|message| {
            let text = message.text.trim();
            if text.is_empty() {
                return None;
            }
            let role = match message.role {
                MessageRole::User => "用户",
                MessageRole::Assistant => "Agent",
                MessageRole::System => "System",
            };
            Some(format!("{role}\n{text}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if content.is_empty() {
        "(该轮没有可显示的文本内容)".to_string()
    } else {
        content
    }
}

fn format_compact_count(value: usize) -> String {
    fn scaled(value: usize, divisor: usize, suffix: char) -> String {
        let hundredths = value.saturating_mul(100) / divisor;
        let whole = hundredths / 100;
        let fraction = hundredths % 100;
        match fraction {
            0 => format!("{whole}{suffix}"),
            fraction if fraction % 10 == 0 => {
                format!("{whole}.{}{suffix}", fraction / 10)
            }
            fraction => format!("{whole}.{fraction:02}{suffix}"),
        }
    }

    if value >= 1_000_000 {
        scaled(value, 1_000_000, 'M')
    } else if value >= 1_000 {
        scaled(value, 1_000, 'K')
    } else {
        value.to_string()
    }
}

fn parse_turn_jump(input: &str, turn_count: usize) -> Result<usize, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("请输入轮次".to_string());
    }
    let turn = input
        .parse::<usize>()
        .ok()
        .filter(|turn| (1..=turn_count).contains(turn))
        .ok_or_else(|| format!("请输入 1-{turn_count} 之间的轮次"))?;
    Ok(turn)
}

fn turn_scroll_child_index(
    sessions: &[(bool, usize)],
    session_index: usize,
    turn_number: usize,
) -> Option<usize> {
    let (selected, turn_count) = *sessions.get(session_index)?;
    if !selected || !(1..=turn_count).contains(&turn_number) {
        return None;
    }
    let preceding_cards = sessions[..session_index]
        .iter()
        .filter(|(selected, _)| *selected)
        .map(|(_, turn_count)| *turn_count)
        .sum::<usize>();
    Some(session_index + preceding_cards + turn_number - 1)
}

fn scroll_session_index(sessions: &[(bool, usize)], child_index: usize) -> usize {
    let mut cursor = 0;
    let mut active_session = 0;
    for (session_index, (selected, turn_count)) in sessions.iter().copied().enumerate() {
        if session_index > 0 {
            if child_index == cursor {
                return active_session;
            }
            cursor += 1;
        }
        if selected {
            if child_index < cursor.saturating_add(turn_count) {
                return session_index;
            }
            cursor = cursor.saturating_add(turn_count);
            active_session = session_index;
        }
    }
    active_session
}

pub(super) fn pack_selected_turns(
    turns: &[CompressedTurn],
    selected: &HashSet<usize>,
    limit_chars: usize,
) -> ChunkPlan {
    let mut plan = ChunkPlan::default();
    let mut current: Option<TurnBlock> = None;

    for turn in turns.iter().filter(|turn| selected.contains(&turn.number)) {
        let turn_chars = turn.markdown.chars().count();
        if turn_chars > limit_chars {
            if let Some(block) = current.take() {
                plan.blocks.push(block);
            }
            plan.oversized_turns.push(turn.number);
            continue;
        }

        match current.as_mut() {
            Some(block)
                if block.markdown.chars().count().saturating_add(turn_chars) <= limit_chars =>
            {
                block.turn_numbers.push(turn.number);
                block.end_seq = turn.end_seq;
                block.markdown.push_str(&turn.markdown);
            }
            Some(_) => {
                plan.blocks.push(current.take().expect("current block"));
                current = Some(block_from_turn(turn));
            }
            None => current = Some(block_from_turn(turn)),
        }
    }
    if let Some(block) = current {
        plan.blocks.push(block);
    }
    plan
}

fn block_from_turn(turn: &CompressedTurn) -> TurnBlock {
    TurnBlock {
        turn_numbers: vec![turn.number],
        start_seq: turn.start_seq,
        end_seq: turn.end_seq,
        markdown: turn.markdown.clone(),
    }
}

#[cfg(test)]
pub(super) fn assemble_chunk_output(
    title: &str,
    blocks: &[TurnBlock],
    outputs: &[String],
) -> anyhow::Result<String> {
    if blocks.len() != outputs.len() {
        return Err(anyhow::anyhow!(
            "chunk output count mismatch: {} blocks, {} outputs",
            blocks.len(),
            outputs.len()
        ));
    }
    let mut markdown = format!("# {title} - 分块压缩结果\n\n");
    for (index, (block, output)) in blocks.iter().zip(outputs).enumerate() {
        let turn_range = turn_numbers_label(&block.turn_numbers);
        markdown.push_str(&format!(
            "## 块 {}（{}，seq {}-{}）\n\n{}\n\n",
            index + 1,
            turn_range,
            block.start_seq,
            block.end_seq,
            output.trim()
        ));
    }
    Ok(markdown)
}

#[cfg(test)]
fn merge_chunk_memory_candidates(
    outputs: &[String],
) -> (Vec<ContextosMemoryCandidate>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();
    for (index, output) in outputs.iter().enumerate() {
        match parse_contextos_memory_candidates(output) {
            Ok(block_candidates) => candidates.extend(block_candidates),
            Err(error) => warnings.push(format!("第 {} 块：{error:#}", index + 1)),
        }
    }
    (candidates, warnings)
}

#[cfg(test)]
pub(super) fn turn_numbers_label(numbers: &[usize]) -> String {
    match (numbers.first(), numbers.last()) {
        (None, _) => "无轮次".to_string(),
        (Some(first), Some(last)) if first == last => format!("第 {first} 轮"),
        (Some(first), Some(last))
            if numbers
                .windows(2)
                .all(|pair| pair[1] == pair[0].saturating_add(1)) =>
        {
            format!("第 {first}-{last} 轮")
        }
        _ => format!(
            "第 {} 轮",
            numbers
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join("、")
        ),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChunkInputScope {
    Single,
    Relationships,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChunkSelectionMode {
    Auto,
    Manual,
}

struct ChunkSessionRow {
    meta: SessionMeta,
    selected: bool,
    selected_turns: HashSet<usize>,
    turns: Option<Vec<CompressedTurn>>,
    error: Option<String>,
    jump_input: Entity<InputState>,
    jump_error: Option<String>,
}

impl ChunkSessionRow {
    fn plan(&self, mode: ChunkSelectionMode, limit_chars: usize) -> Option<ChunkPlan> {
        let turns = self.turns.as_ref()?;
        let selected = if mode == ChunkSelectionMode::Auto {
            turns.iter().map(|turn| turn.number).collect()
        } else {
            self.selected_turns.clone()
        };
        Some(pack_selected_turns(turns, &selected, limit_chars))
    }

    fn compressed_chars(&self) -> usize {
        self.turns
            .as_ref()
            .map(|turns| turns.iter().map(|turn| turn.markdown.chars().count()).sum())
            .unwrap_or_default()
    }
}

struct PreparedChunkSession {
    key: String,
    turns: Option<Vec<CompressedTurn>>,
    error: Option<String>,
}

#[derive(Clone)]
struct ChunkExportJob {
    meta: SessionMeta,
    blocks: Vec<TurnBlock>,
}

enum ChunkExportDestination {
    File(PathBuf),
    Directory(PathBuf),
}

struct ChunkBatchResult {
    completed: Vec<PathBuf>,
    failures: Vec<String>,
    warnings: Vec<String>,
    memory_candidates: Vec<(SessionMeta, Vec<ContextosMemoryCandidate>)>,
}

struct ChunkInputView {
    focus_handle: FocusHandle,
    scope: ChunkInputScope,
    settings: CompressionSettings,
    store: Arc<Store>,
    adapters: SharedAdapters,
    workbench: Entity<Workbench>,
    rows: Vec<ChunkSessionRow>,
    scroll_handle: ScrollHandle,
    expanded_turns: HashSet<(String, usize)>,
    highlighted_turn: Option<(String, usize)>,
    highlight_generation: u64,
    mode: ChunkSelectionMode,
    loading: bool,
    running: bool,
    result_message: Option<String>,
}

impl ChunkInputView {
    fn new(
        scope: ChunkInputScope,
        sessions: Vec<SessionMeta>,
        current_key: &str,
        settings: CompressionSettings,
        store: Arc<Store>,
        adapters: SharedAdapters,
        workbench: Entity<Workbench>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let rows = sessions
            .into_iter()
            .map(|meta| {
                let session_key = meta.key.clone();
                let jump_input = cx.new(|cx| InputState::new(window, cx).placeholder("跳到轮次"));
                cx.subscribe_in(
                    &jump_input,
                    window,
                    move |this, input, event, window, cx| match event {
                        InputEvent::Change => {
                            if let Some(row) =
                                this.rows.iter_mut().find(|row| row.meta.key == session_key)
                            {
                                row.jump_error = None;
                            }
                            cx.notify();
                        }
                        InputEvent::PressEnter { .. } => {
                            let value = input.read(cx).value().to_string();
                            this.jump_to_turn(&session_key, &value, window, cx);
                        }
                        _ => {}
                    },
                )
                .detach();
                ChunkSessionRow {
                    selected: scope == ChunkInputScope::Single || meta.key == current_key,
                    meta,
                    selected_turns: HashSet::new(),
                    turns: None,
                    error: None,
                    jump_input,
                    jump_error: None,
                }
            })
            .collect();
        Self {
            focus_handle: cx.focus_handle(),
            scope,
            settings,
            store,
            adapters,
            workbench,
            rows,
            scroll_handle: ScrollHandle::new(),
            expanded_turns: HashSet::new(),
            highlighted_turn: None,
            highlight_generation: 0,
            mode: ChunkSelectionMode::Auto,
            loading: true,
            running: false,
            result_message: None,
        }
    }

    fn prepare(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let adapters = self.adapters.clone();
        let metas = self
            .rows
            .iter()
            .map(|row| row.meta.clone())
            .collect::<Vec<_>>();
        let task = cx.background_spawn(async move {
            metas
                .into_iter()
                .map(|meta| match prepare_chunk_session(&adapters, &meta) {
                    Ok(turns) => PreparedChunkSession {
                        key: meta.key,
                        turns: Some(turns),
                        error: None,
                    },
                    Err(error) => PreparedChunkSession {
                        key: meta.key,
                        turns: None,
                        error: Some(format!("{error:#}")),
                    },
                })
                .collect::<Vec<_>>()
        });
        cx.spawn_in(window, async move |this, cx| {
            let prepared = task.await;
            this.update_in(cx, |this, _, cx| {
                for item in prepared {
                    if let Some(row) = this.rows.iter_mut().find(|row| row.meta.key == item.key) {
                        row.turns = item.turns;
                        row.error = item.error;
                        if let Some(turns) = &row.turns {
                            row.selected_turns = turns.iter().map(|turn| turn.number).collect();
                        }
                    }
                }
                this.loading = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn set_mode(&mut self, mode: ChunkSelectionMode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.result_message = None;
        self.scroll_handle.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    fn set_session_selected(&mut self, key: &str, selected: bool, cx: &mut Context<Self>) {
        if let Some(row) = self.rows.iter_mut().find(|row| row.meta.key == key) {
            row.selected = selected;
        }
        self.result_message = None;
        cx.notify();
    }

    fn set_turn_selected(
        &mut self,
        session_key: &str,
        turn_number: usize,
        selected: bool,
        cx: &mut Context<Self>,
    ) {
        if let Some(row) = self.rows.iter_mut().find(|row| row.meta.key == session_key) {
            if selected {
                row.selected_turns.insert(turn_number);
            } else {
                row.selected_turns.remove(&turn_number);
            }
        }
        self.result_message = None;
        cx.notify();
    }

    fn toggle_turn_expanded(
        &mut self,
        session_key: &str,
        turn_number: usize,
        cx: &mut Context<Self>,
    ) {
        let key = (session_key.to_string(), turn_number);
        if !self.expanded_turns.remove(&key) {
            self.expanded_turns.insert(key);
        }
        cx.notify();
    }

    fn scroll_child_index_for_turn(&self, session_key: &str, turn_number: usize) -> Option<usize> {
        if self.mode != ChunkSelectionMode::Manual {
            return None;
        }
        let session_index = self
            .rows
            .iter()
            .position(|row| row.meta.key == session_key)?;
        let sessions = self
            .rows
            .iter()
            .map(|row| (row.selected, row.turns.as_ref().map(Vec::len).unwrap_or(0)))
            .collect::<Vec<_>>();
        turn_scroll_child_index(&sessions, session_index, turn_number)
    }

    fn jump_to_turn(
        &mut self,
        session_key: &str,
        input: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let turn_count = self
            .rows
            .iter()
            .find(|row| row.meta.key == session_key)
            .and_then(|row| row.turns.as_ref())
            .map(Vec::len)
            .unwrap_or_default();
        let turn_number = match parse_turn_jump(input, turn_count) {
            Ok(turn_number) => turn_number,
            Err(error) => {
                if let Some(row) = self.rows.iter_mut().find(|row| row.meta.key == session_key) {
                    row.jump_error = Some(error);
                }
                cx.notify();
                return;
            }
        };
        let Some(child_index) = self.scroll_child_index_for_turn(session_key, turn_number) else {
            return;
        };
        if let Some(row) = self.rows.iter_mut().find(|row| row.meta.key == session_key) {
            row.jump_error = None;
        }
        self.scroll_handle.scroll_to_top_of_item(child_index);
        self.highlight_generation = self.highlight_generation.wrapping_add(1);
        let generation = self.highlight_generation;
        self.highlighted_turn = Some((session_key.to_string(), turn_number));
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1_500))
                .await;
            this.update_in(cx, |this, _, cx| {
                if this.highlight_generation == generation {
                    this.highlighted_turn = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn render_session_header(
        &self,
        row: &ChunkSessionRow,
        entity: &Entity<Self>,
        separator: bool,
        show_jump: bool,
        cx: &App,
    ) -> AnyElement {
        let theme = cx.theme();
        let key = row.meta.key.clone();
        let selected = row.selected;
        let turn_count = row.turns.as_ref().map(Vec::len);
        let subtitle = match turn_count {
            Some(turn_count) => format!(
                "{} · {} · 共 {} 轮 · {} chars",
                row.meta.agent.display_name(),
                if row.meta.project_name.is_empty() {
                    row.meta.project_path.as_str()
                } else {
                    row.meta.project_name.as_str()
                },
                turn_count,
                format_compact_count(row.compressed_chars())
            ),
            None => format!(
                "{} · {} · 轮次计算中…",
                row.meta.agent.display_name(),
                if row.meta.project_name.is_empty() {
                    row.meta.project_path.as_str()
                } else {
                    row.meta.project_name.as_str()
                }
            ),
        };
        let session_entity = entity.clone();
        let checkbox_key = key.clone();
        let jump_control = if show_jump
            && selected
            && self.mode == ChunkSelectionMode::Manual
            && turn_count.is_some()
        {
            let jump_input = row.jump_input.clone();
            let jump_button_input = jump_input.clone();
            let jump_key = key.clone();
            let jump_entity = entity.clone();
            Some(
                v_flex()
                    .w(px(188.))
                    .flex_shrink_0()
                    .gap(px(3.))
                    .child(
                        h_flex()
                            .gap(SPACE_XS)
                            .child(
                                div().flex_1().min_w_0().child(
                                    Input::new(&jump_input)
                                        .with_size(gpui_component::Size::Small)
                                        .prefix(
                                            icon("icons/search.svg")
                                                .with_size(px(14.))
                                                .text_color(theme.muted_foreground),
                                        ),
                                ),
                            )
                            .child(
                                Button::new(SharedString::from(format!("chunk-jump-pinned-{key}")))
                                    .small()
                                    .outline()
                                    .icon(icon("icons/chevron-right.svg").with_size(px(14.)))
                                    .tooltip("跳到轮次")
                                    .on_click(move |_, window, cx| {
                                        let value = jump_button_input.read(cx).value().to_string();
                                        jump_entity.update(cx, |this, cx| {
                                            this.jump_to_turn(&jump_key, &value, window, cx);
                                        });
                                    }),
                            ),
                    )
                    .when_some(row.jump_error.clone(), |this, error| {
                        this.child(
                            div()
                                .text_size(FONT_LABEL)
                                .text_color(theme.danger)
                                .child(error),
                        )
                    })
                    .into_any_element(),
            )
        } else {
            None
        };
        let mut header = h_flex()
            .w_full()
            .flex_shrink_0()
            .items_center()
            .gap(SPACE_SM)
            .px(SPACE_XL)
            .py(SPACE_SM)
            .when(separator, |this| {
                this.mt(SPACE_SM)
                    .border_t_1()
                    .border_b_1()
                    .border_color(theme.border)
                    .bg(theme.background)
            })
            .when(self.scope == ChunkInputScope::Relationships, |this| {
                this.child(
                    Checkbox::new(SharedString::from(format!(
                        "chunk-session-{}-{key}",
                        if separator { "inline" } else { "pinned" }
                    )))
                    .checked(selected)
                    .on_click(move |checked, _, cx| {
                        session_entity.update(cx, |this, cx| {
                            this.set_session_selected(&checkbox_key, *checked, cx);
                        });
                    }),
                )
            })
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .truncate()
                            .text_size(FONT_BODY)
                            .font_medium()
                            .child(row.meta.title.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(subtitle),
                    )
                    .when_some(row.error.clone(), |this, error| {
                        this.child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.danger)
                                .child(error),
                        )
                    }),
            );
        if let Some(jump_control) = jump_control {
            header = header.child(jump_control);
        }
        header.into_any_element()
    }

    fn jobs(&self) -> anyhow::Result<Vec<ChunkExportJob>> {
        if self.loading {
            return Err(anyhow::anyhow!("会话仍在准备中"));
        }
        let mut jobs = Vec::new();
        for row in self.rows.iter().filter(|row| row.selected) {
            if let Some(error) = &row.error {
                return Err(anyhow::anyhow!("{}：{}", row.meta.title, error));
            }
            let plan = row
                .plan(self.mode, self.settings.llm_input_limit_chars)
                .ok_or_else(|| anyhow::anyhow!("{}：尚未生成轮次", row.meta.title))?;
            if !plan.oversized_turns.is_empty() {
                return Err(anyhow::anyhow!(
                    "{}：第 {} 轮自身超过字符上限，请切换到逐轮选择并排除，或调高上限",
                    row.meta.title,
                    plan.oversized_turns
                        .iter()
                        .map(usize::to_string)
                        .collect::<Vec<_>>()
                        .join("、")
                ));
            }
            if plan.blocks.is_empty() {
                return Err(anyhow::anyhow!("{}：没有选中可输入的轮次", row.meta.title));
            }
            jobs.push(ChunkExportJob {
                meta: row.meta.clone(),
                blocks: plan.blocks,
            });
        }
        if jobs.is_empty() {
            return Err(anyhow::anyhow!("请至少选择一个会话"));
        }
        Ok(jobs)
    }

    fn start_export(
        &mut self,
        export_mode: CompressionExportMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.running {
            return;
        }
        if export_mode == CompressionExportMode::WithMemory && !self.settings.llm_enabled {
            self.result_message =
                Some("压缩并生成记忆需要启用 LLM；普通分块压缩可以只使用 Laya".to_string());
            cx.notify();
            return;
        }
        let jobs = match self.jobs() {
            Ok(jobs) => jobs,
            Err(error) => {
                self.result_message = Some(format!("无法开始：{error:#}"));
                cx.notify();
                return;
            }
        };
        let settings = self.settings.clone();
        let store = self.store.clone();
        let adapters = self.adapters.clone();
        let start = export_dir(&store);
        self.running = true;
        self.result_message = Some("等待选择输出位置…".to_string());
        cx.notify();

        match self.scope {
            ChunkInputScope::Single => {
                let meta = jobs[0].meta.clone();
                let mut name = exporter::default_file_name(&meta, "md");
                name = name.trim_end_matches(".md").to_string();
                name.push_str(match export_mode {
                    CompressionExportMode::Plain => "-chunked-compressed.md",
                    CompressionExportMode::WithMemory => "-chunked-compressed-memory.md",
                });
                let rx = cx.prompt_for_new_path(&start, Some(&name));
                cx.spawn_in(window, async move |this, cx| {
                    let path = match rx.await {
                        Ok(Ok(Some(path))) => path,
                        Ok(Err(_)) => start.join(name),
                        _ => {
                            this.update_in(cx, |this, _, cx| {
                                this.running = false;
                                this.result_message = None;
                                cx.notify();
                            })
                            .ok();
                            return;
                        }
                    };
                    run_chunk_jobs_from_view(
                        this,
                        jobs,
                        settings,
                        store,
                        adapters,
                        ChunkExportDestination::File(path),
                        export_mode,
                        cx,
                    )
                    .await;
                })
                .detach();
            }
            ChunkInputScope::Relationships => {
                let rx = cx.prompt_for_paths(PathPromptOptions {
                    files: false,
                    directories: true,
                    multiple: false,
                    prompt: Some(
                        if export_mode == CompressionExportMode::WithMemory {
                            "选择分块压缩与记忆输出目录"
                        } else {
                            "选择分块压缩输出目录"
                        }
                        .into(),
                    ),
                });
                cx.spawn_in(window, async move |this, cx| {
                    let directory = match rx.await {
                        Ok(Ok(Some(paths))) if !paths.is_empty() => paths[0].clone(),
                        _ => {
                            this.update_in(cx, |this, _, cx| {
                                this.running = false;
                                this.result_message = None;
                                cx.notify();
                            })
                            .ok();
                            return;
                        }
                    };
                    run_chunk_jobs_from_view(
                        this,
                        jobs,
                        settings,
                        store,
                        adapters,
                        ChunkExportDestination::Directory(directory),
                        export_mode,
                        cx,
                    )
                    .await;
                })
                .detach();
            }
        }
    }
}

async fn run_chunk_jobs_from_view(
    this: WeakEntity<ChunkInputView>,
    jobs: Vec<ChunkExportJob>,
    settings: CompressionSettings,
    store: Arc<Store>,
    adapters: SharedAdapters,
    destination: ChunkExportDestination,
    export_mode: CompressionExportMode,
    cx: &mut AsyncWindowContext,
) {
    this.update_in(cx, |this, _, cx| {
        this.result_message = Some(format!("正在处理 {} 个会话…", jobs.len()));
        cx.notify();
    })
    .ok();
    let result = cx
        .background_spawn(async move {
            run_chunk_export_jobs(jobs, &settings, &store, &adapters, destination, export_mode)
        })
        .await;
    this.update_in(cx, |this, window, cx| {
        this.running = false;
        let candidate_count = result
            .memory_candidates
            .iter()
            .map(|(_, candidates)| candidates.len())
            .sum::<usize>();
        let message = if result.failures.is_empty() && result.warnings.is_empty() {
            if export_mode == CompressionExportMode::WithMemory {
                format!(
                    "已完成 {} 个会话，生成 {} 条记忆候选",
                    result.completed.len(),
                    candidate_count
                )
            } else {
                format!("已完成 {} 个会话", result.completed.len())
            }
        } else {
            let mut details = Vec::new();
            if !result.failures.is_empty() {
                details.push(format!(
                    "失败 {} 个：{}",
                    result.failures.len(),
                    result.failures.join("；")
                ));
            }
            if !result.warnings.is_empty() {
                details.push(format!("警告：{}", result.warnings.join("；")));
            }
            format!(
                "完成 {} 个会话，{}",
                result.completed.len(),
                details.join("；")
            )
        };
        this.result_message = Some(message.clone());
        let notification = if result.failures.is_empty() && result.warnings.is_empty() {
            Notification::success(message)
        } else {
            Notification::warning(message)
        };
        window.push_notification(notification, cx);
        for (meta, candidates) in result.memory_candidates {
            if candidates.is_empty() {
                continue;
            }
            let workbench = this.workbench.clone();
            cx.defer(move |cx| {
                Workbench::show_memory_candidates_window(workbench, candidates, meta, cx);
            });
        }
        cx.notify();
    })
    .ok();
}

fn prepare_chunk_session(
    adapters: &SharedAdapters,
    meta: &SessionMeta,
) -> anyhow::Result<Vec<CompressedTurn>> {
    let adapter = adapter_for(adapters, meta.agent, &meta.file_path)
        .ok_or_else(|| anyhow::anyhow!("no adapter for this session"))?;
    let session_ref = SessionFileRef::from_meta(meta);
    let transcript = adapter.parse_transcript(&session_ref)?;
    let mut messages = transcript.mainline;
    for sidechain in transcript.sidechains {
        messages.extend(adapter.load_sidechain(&session_ref, &sidechain.id)?);
    }
    let turns = group_complete_turns(&messages);
    if turns.is_empty() {
        return Err(anyhow::anyhow!("会话没有可输入的完整轮次"));
    }
    build_compressed_turns(&turns, |fragment| {
        Ok(compact_markdown_details(fragment, meta, None)?.markdown)
    })
}

fn run_chunk_export_jobs(
    jobs: Vec<ChunkExportJob>,
    settings: &CompressionSettings,
    store: &Store,
    adapters: &SharedAdapters,
    destination: ChunkExportDestination,
    export_mode: CompressionExportMode,
) -> ChunkBatchResult {
    let mut result = ChunkBatchResult {
        completed: Vec::new(),
        failures: Vec::new(),
        warnings: Vec::new(),
        memory_candidates: Vec::new(),
    };
    for job in jobs {
        let path = match &destination {
            ChunkExportDestination::File(path) => path.clone(),
            ChunkExportDestination::Directory(directory) => {
                let mut name = exporter::default_file_name(&job.meta, "md");
                name = name.trim_end_matches(".md").to_string();
                let id = safe_file_stem(&job.meta.id)
                    .chars()
                    .take(8)
                    .collect::<String>();
                let suffix = match export_mode {
                    CompressionExportMode::Plain => "chunked-compressed",
                    CompressionExportMode::WithMemory => "chunked-compressed-memory",
                };
                directory.join(format!("{name}-{id}-{suffix}.md"))
            }
        };
        let turn_numbers = job
            .blocks
            .iter()
            .flat_map(|block| block.turn_numbers.iter().copied())
            .collect::<Vec<_>>();
        let run = wake_core::services::compression::run_inputs(
            store,
            adapters.as_slice(),
            &[wake_core::services::compression::SessionInput {
                session_key: job.meta.key.clone(),
                turn_numbers: Some(turn_numbers),
            }],
            &wake_core::services::compression::RunOverrides {
                jev_enabled: Some(settings.jev_enabled),
                llm_enabled: Some(settings.llm_enabled),
                generate_memory_candidates: export_mode == CompressionExportMode::WithMemory,
                continuation_context: None,
            },
        );
        match run.and_then(|compressed| {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    wake_core::services::compression::CompressionError {
                        kind: wake_core::services::compression::CompressionErrorKind::Internal,
                        message: error.to_string(),
                        diagnostic: serde_json::json!({"stage":"write_output","path":path}),
                    }
                })?;
            }
            let output = format!(
                "{}{}",
                compressed.processing_report_markdown(),
                compressed.markdown
            );
            std::fs::write(&path, output).map_err(|error| {
                wake_core::services::compression::CompressionError {
                    kind: wake_core::services::compression::CompressionErrorKind::Internal,
                    message: error.to_string(),
                    diagnostic: serde_json::json!({"stage":"write_output","path":path}),
                }
            })?;
            Ok(compressed)
        }) {
            Ok(compressed) => {
                if !compressed.memory_candidates.is_empty() {
                    result
                        .memory_candidates
                        .push((job.meta.clone(), compressed.memory_candidates));
                }
                if let Some(parent) = path.parent() {
                    let _ = store.pref_set("export_dir", &parent.to_string_lossy());
                }
                result.completed.push(path);
            }
            Err(error) => result.failures.push(format!(
                "{}：{}；诊断：{}",
                job.meta.title, error.message, error.diagnostic
            )),
        }
    }
    result
}

impl Focusable for ChunkInputView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for ChunkInputView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let entity = cx.entity();
        let auto = self.mode == ChunkSelectionMode::Auto;
        let selected_sessions = self.rows.iter().filter(|row| row.selected).count();
        let plans = self
            .rows
            .iter()
            .filter(|row| row.selected)
            .filter_map(|row| row.plan(self.mode, self.settings.llm_input_limit_chars))
            .collect::<Vec<_>>();
        let block_count = plans.iter().map(|plan| plan.blocks.len()).sum::<usize>();
        let oversized_count = plans
            .iter()
            .map(|plan| plan.oversized_turns.len())
            .sum::<usize>();
        let can_run = !self.loading
            && !self.running
            && selected_sessions > 0
            && block_count > 0
            && oversized_count == 0
            && self
                .rows
                .iter()
                .filter(|row| row.selected)
                .all(|row| row.error.is_none());

        let session_layout = self
            .rows
            .iter()
            .map(|row| {
                (
                    row.selected && !auto,
                    row.turns.as_ref().map(Vec::len).unwrap_or_default(),
                )
            })
            .collect::<Vec<_>>();
        let active_session_index = scroll_session_index(
            &session_layout,
            self.scroll_handle
                .top_item()
                .min(self.scroll_handle.children_count().saturating_sub(1)),
        )
        .min(self.rows.len().saturating_sub(1));
        let pinned_header = self
            .rows
            .get(active_session_index)
            .map(|row| self.render_session_header(row, &entity, false, true, cx));
        let mut scroll_rows = Vec::new();
        for (row_index, row) in self.rows.iter().enumerate() {
            let selected = row.selected;
            if row_index > 0 {
                scroll_rows.push(self.render_session_header(row, &entity, true, false, cx));
            }

            if !selected || auto {
                continue;
            }
            let Some(turns) = &row.turns else { continue };
            for turn in turns {
                let session_key = row.meta.key.clone();
                let turn_number = turn.number;
                let checked = row.selected_turns.contains(&turn.number);
                let expanded = self
                    .expanded_turns
                    .contains(&(session_key.clone(), turn_number));
                let highlighted = self
                    .highlighted_turn
                    .as_ref()
                    .is_some_and(|target| target == &(session_key.clone(), turn_number));
                let turn_entity = entity.clone();
                let expand_entity = entity.clone();
                let expand_session_key = session_key.clone();
                let metadata = format!(
                    "第 {} 轮  ·  seq {}-{}  ·  {} chars",
                    turn.number,
                    turn.start_seq,
                    turn.end_seq,
                    format_compact_count(turn.markdown.chars().count())
                );
                let content = turn.display_content.clone();
                scroll_rows.push(
                    v_flex()
                        .id(SharedString::from(format!(
                            "chunk-turn-card-{session_key}-{turn_number}"
                        )))
                        .w_full()
                        .flex_shrink_0()
                        .overflow_hidden()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(if highlighted {
                            theme.primary
                        } else if checked {
                            theme.primary.opacity(0.38)
                        } else {
                            theme.border
                        })
                        .bg(if highlighted {
                            theme.primary.opacity(0.06)
                        } else {
                            theme.popover
                        })
                        .cursor_pointer()
                        .hover(|style| style.bg(theme.secondary_hover.opacity(0.45)))
                        .on_click(move |_, _, cx| {
                            expand_entity.update(cx, |this, cx| {
                                this.toggle_turn_expanded(&expand_session_key, turn_number, cx);
                            });
                        })
                        .child(
                            h_flex()
                                .items_center()
                                .gap(SPACE_SM)
                                .px(SPACE_MD)
                                .py(SPACE_SM)
                                .border_b_1()
                                .border_color(theme.border.opacity(0.72))
                                .child(
                                    div()
                                        .id(SharedString::from(format!(
                                            "chunk-turn-check-{session_key}-{turn_number}"
                                        )))
                                        .on_click(|_, _, cx| cx.stop_propagation())
                                        .child(
                                            Checkbox::new(SharedString::from(format!(
                                                "chunk-turn-{session_key}-{turn_number}"
                                            )))
                                            .checked(checked)
                                            .on_click(move |checked, _, cx| {
                                                turn_entity.update(cx, |this, cx| {
                                                    this.set_turn_selected(
                                                        &session_key,
                                                        turn_number,
                                                        *checked,
                                                        cx,
                                                    );
                                                });
                                            }),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .text_size(FONT_CAPTION)
                                        .font_medium()
                                        .text_color(theme.muted_foreground)
                                        .child(metadata),
                                )
                                .child(
                                    icon("icons/chevron-down.svg")
                                        .with_size(px(15.))
                                        .text_color(theme.muted_foreground)
                                        .when(expanded, |icon| {
                                            icon.rotate(gpui::Radians(std::f32::consts::PI))
                                        }),
                                ),
                        )
                        .child(
                            div().w_full().px(SPACE_MD).py(SPACE_MD).child(
                                div()
                                    .w_full()
                                    .whitespace_normal()
                                    .text_size(FONT_BODY)
                                    .line_height(px(21.))
                                    .when(!expanded, |this| this.max_h(px(63.)).overflow_hidden())
                                    .child(content),
                            ),
                        )
                        .into_any_element(),
                );
            }
        }

        let mode_auto_entity = entity.clone();
        let mode_manual_entity = entity.clone();
        let memory_entity = entity.clone();
        let start_entity = entity.clone();
        div()
            .id("chunk-input-window")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(
                v_flex()
                    .size_full()
                    .child(
                        h_flex()
                            .flex_shrink_0()
                            .h(WINDOW_TITLEBAR_HEIGHT)
                            .px(SPACE_XL)
                            .items_center()
                            .border_b_1()
                            .border_color(theme.border)
                            .child(div().text_size(FONT_HEADING).font_semibold().child(
                                if self.scope == ChunkInputScope::Single {
                                    "分块输入（长对话）"
                                } else {
                                    "选择会话并分块输入"
                                },
                            ))
                            .child(div().flex_1())
                            .child(
                                Button::new("chunk-input-close")
                                    .ghost()
                                    .icon(icon("icons/x.svg").with_size(px(16.)))
                                    .tooltip("关闭")
                                    .on_click(|_, window, _| window.remove_window()),
                            ),
                    )
                    .child(
                        h_flex()
                            .flex_shrink_0()
                            .px(SPACE_XL)
                            .py(SPACE_MD)
                            .gap(SPACE_SM)
                            .items_center()
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                Button::new("chunk-mode-auto")
                                    .label("自动划分")
                                    .when(auto, |button| button.primary())
                                    .when(!auto, |button| button.outline())
                                    .on_click(move |_, _, cx| {
                                        mode_auto_entity.update(cx, |this, cx| {
                                            this.set_mode(ChunkSelectionMode::Auto, cx);
                                        });
                                    }),
                            )
                            .child(
                                Button::new("chunk-mode-manual")
                                    .label("逐轮选择")
                                    .when(!auto, |button| button.primary())
                                    .when(auto, |button| button.outline())
                                    .on_click(move |_, _, cx| {
                                        mode_manual_entity.update(cx, |this, cx| {
                                            this.set_mode(ChunkSelectionMode::Manual, cx);
                                        });
                                    }),
                            )
                            .child(div().flex_1())
                            .child(
                                div()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(format!(
                                        "上限 {} chars · {} 个会话 · {} 个块",
                                        format_compact_count(self.settings.llm_input_limit_chars),
                                        selected_sessions,
                                        block_count
                                    )),
                            ),
                    )
                    .when_some(pinned_header, |this, header| {
                        this.child(
                            div()
                                .id("chunk-pinned-session-header")
                                .flex_shrink_0()
                                .border_b_1()
                                .border_color(theme.border)
                                .bg(theme.background)
                                .child(header),
                        )
                    })
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            .child(
                                v_flex()
                                    .id("chunk-input-scroll")
                                    .size_full()
                                    .px(SPACE_XL)
                                    .py(SPACE_MD)
                                    .gap(SPACE_MD)
                                    .overflow_y_scroll()
                                    .track_scroll(&self.scroll_handle)
                                    .children(scroll_rows)
                                    .when(self.loading, |this| {
                                        this.child(
                                            h_flex()
                                                .justify_center()
                                                .gap(SPACE_SM)
                                                .p(SPACE_XXL)
                                                .child(Spinner::new())
                                                .child("正在按完整轮次进行机械压缩…"),
                                        )
                                    }),
                            )
                            .vertical_scrollbar(&self.scroll_handle),
                    )
                    .child(
                        h_flex()
                            .flex_shrink_0()
                            .px(SPACE_XL)
                            .py(SPACE_MD)
                            .gap(SPACE_MD)
                            .items_center()
                            .border_t_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(FONT_CAPTION)
                                    .text_color(if oversized_count > 0 {
                                        theme.danger
                                    } else {
                                        theme.muted_foreground
                                    })
                                    .child(self.result_message.clone().unwrap_or_else(|| {
                                        if oversized_count > 0 {
                                            format!("有 {oversized_count} 个完整轮次自身超过上限")
                                        } else if auto {
                                            "自动模式保留全部轮次，块间上下文可能不连续。"
                                                .to_string()
                                        } else {
                                            "可逐轮排除无用内容；选中轮次按原始顺序输入。"
                                                .to_string()
                                        }
                                    })),
                            )
                            .child(
                                Button::new("chunk-input-memory")
                                    .label(if self.running {
                                        "处理中…"
                                    } else {
                                        "输入并生成记忆"
                                    })
                                    .icon(icon("icons/brain.svg").with_size(px(15.)))
                                    .outline()
                                    .disabled(!can_run)
                                    .on_click(move |_, window, cx| {
                                        memory_entity.update(cx, |this, cx| {
                                            this.start_export(
                                                CompressionExportMode::WithMemory,
                                                window,
                                                cx,
                                            );
                                        });
                                    }),
                            )
                            .child(
                                Button::new("chunk-input-start")
                                    .label(if self.running {
                                        "处理中…"
                                    } else {
                                        "开始输入 LLM"
                                    })
                                    .primary()
                                    .disabled(!can_run)
                                    .on_click(move |_, window, cx| {
                                        start_entity.update(cx, |this, cx| {
                                            this.start_export(
                                                CompressionExportMode::Plain,
                                                window,
                                                cx,
                                            );
                                        });
                                    }),
                            ),
                    ),
            )
            .children(overlay_layers(window, cx))
    }
}

impl Workbench {
    pub(super) fn open_single_chunk_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else { return };
        self.open_chunk_input_window(
            ChunkInputScope::Single,
            vec![detail.meta.clone()],
            detail.meta.key.clone(),
            window,
            cx,
        );
    }

    pub(super) fn open_relationship_chunk_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(detail) = &self.detail else { return };
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        for relation in detail.link_parent_tree.iter().rev() {
            if seen.insert(relation.session.key.clone()) {
                sessions.push(relation.session.clone());
            }
        }
        if seen.insert(detail.meta.key.clone()) {
            sessions.push(detail.meta.clone());
        }
        for relation in &detail.link_child_tree {
            if seen.insert(relation.session.key.clone()) {
                sessions.push(relation.session.clone());
            }
        }
        self.open_chunk_input_window(
            ChunkInputScope::Relationships,
            sessions,
            detail.meta.key.clone(),
            window,
            cx,
        );
    }

    fn open_chunk_input_window(
        &mut self,
        scope: ChunkInputScope,
        sessions: Vec<SessionMeta>,
        current_key: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let settings = self.compression_settings();
        let store = self.store.clone();
        let adapters = self.adapters.clone();
        let workbench = cx.entity();
        cx.defer(move |cx| {
            let (bounds, display_id) =
                crate::main_window::centered_over_main(size(px(920.), px(720.)), cx);
            let title = if scope == ChunkInputScope::Single {
                "分块输入（长对话）"
            } else {
                "选择会话并分块输入"
            };
            let titlebar = TitlebarOptions {
                title: (!cfg!(target_os = "macos")).then(|| title.into()),
                appears_transparent: cfg!(target_os = "macos"),
                traffic_light_position: cfg!(target_os = "macos").then(|| point(px(20.), px(11.))),
            };
            match cx.open_window(
                WindowOptions {
                    titlebar: Some(titlebar),
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(760.), px(520.))),
                    display_id,
                    app_id: Some("contextos-chunk-input".into()),
                    window_decorations: Some(WindowDecorations::Client),
                    ..Default::default()
                },
                move |window, cx| {
                    window
                        .observe_window_appearance(|window, cx| {
                            crate::theme::sync_appearance(Some(window), cx);
                        })
                        .detach();
                    crate::theme::sync_appearance(Some(window), cx);
                    let view = cx.new(|cx| {
                        ChunkInputView::new(
                            scope,
                            sessions,
                            &current_key,
                            settings,
                            store,
                            adapters,
                            workbench,
                            window,
                            cx,
                        )
                    });
                    view.update(cx, |view, cx| view.prepare(window, cx));
                    window.focus(&view.read(cx).focus_handle(cx), cx);
                    cx.new(|cx| Root::new(view, window, cx))
                },
            ) {
                Ok(_) => cx.activate(true),
                Err(error) => eprintln!("failed to open ContextOS chunk input: {error}"),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use wake_core::models::{MessageKind, Role, TranscriptMessage};

    use super::{
        assemble_chunk_output, build_compressed_turns, format_compact_count, group_complete_turns,
        merge_chunk_memory_candidates, pack_selected_turns, parse_turn_jump, scroll_session_index,
        turn_display_content, turn_scroll_child_index, CompressedTurn,
    };

    fn message(seq: i64, role: Role, text: &str) -> TranscriptMessage {
        TranscriptMessage {
            seq,
            role,
            kind: MessageKind::Text,
            text: text.to_string(),
            truncated: false,
            tool_calls: Vec::new(),
            thinking: None,
            timestamp: None,
            model: None,
            images: Vec::new(),
        }
    }

    #[test]
    fn groups_each_user_message_with_following_assistant_messages() {
        let messages = vec![
            message(1, Role::System, "context"),
            message(2, Role::User, "first"),
            message(3, Role::Assistant, "answer"),
            message(4, Role::Assistant, "tool follow-up"),
            message(5, Role::User, "second"),
            message(6, Role::Assistant, "done"),
        ];

        let turns = group_complete_turns(&messages);

        assert_eq!(turns.len(), 2);
        assert_eq!(
            (turns[0].number, turns[0].start_seq, turns[0].end_seq),
            (1, 1, 4)
        );
        assert_eq!(
            (turns[1].number, turns[1].start_seq, turns[1].end_seq),
            (2, 5, 6)
        );
        assert_eq!(turns[0].messages.len(), 4);
        assert_eq!(turns[1].messages.len(), 2);
    }

    #[test]
    fn keeps_a_transcript_without_user_messages_as_one_turn() {
        let messages = vec![
            message(8, Role::System, "context"),
            message(9, Role::Assistant, "result"),
        ];

        let turns = group_complete_turns(&messages);

        assert_eq!(turns.len(), 1);
        assert_eq!((turns[0].start_seq, turns[0].end_seq), (8, 9));
    }

    fn compressed(number: usize, chars: usize) -> CompressedTurn {
        CompressedTurn {
            number,
            start_seq: number as i64 * 10,
            end_seq: number as i64 * 10 + 9,
            display_content: format!("turn {number}"),
            markdown: "x".repeat(chars),
        }
    }

    #[test]
    fn turn_display_keeps_complete_user_and_agent_text() {
        let user = "用户的完整发言，不应该被截断";
        let agent = "Agent 的完整回复，展开后应该全部可见";
        let turns = group_complete_turns(&[
            message(1, Role::User, user),
            message(2, Role::Assistant, agent),
        ]);

        let content = turn_display_content(&turns[0]);

        assert!(content.contains(user));
        assert!(content.contains(agent));
        assert!(content.starts_with("用户\n"));
        assert!(content.contains("\n\nAgent\n"));
    }

    #[test]
    fn compact_counts_use_decimal_k_and_m_suffixes() {
        assert_eq!(format_compact_count(999), "999");
        assert_eq!(format_compact_count(1_000), "1K");
        assert_eq!(format_compact_count(12_400), "12.4K");
        assert_eq!(format_compact_count(1_524_912), "1.52M");
        assert_eq!(format_compact_count(100_000_000), "100M");
    }

    #[test]
    fn turn_jump_accepts_only_an_existing_turn_number() {
        assert_eq!(parse_turn_jump(" 18 ", 24), Ok(18));
        assert_eq!(parse_turn_jump("", 24), Err("请输入轮次".to_string()));
        assert_eq!(
            parse_turn_jump("abc", 24),
            Err("请输入 1-24 之间的轮次".to_string())
        );
        assert_eq!(
            parse_turn_jump("25", 24),
            Err("请输入 1-24 之间的轮次".to_string())
        );
    }

    #[test]
    fn scroll_index_counts_only_cards_from_selected_sessions() {
        let sessions = [(true, 3), (false, 5), (true, 4)];

        assert_eq!(turn_scroll_child_index(&sessions, 0, 1), Some(0));
        assert_eq!(turn_scroll_child_index(&sessions, 0, 3), Some(2));
        assert_eq!(turn_scroll_child_index(&sessions, 1, 1), None);
        assert_eq!(turn_scroll_child_index(&sessions, 2, 2), Some(6));
        assert_eq!(turn_scroll_child_index(&sessions, 2, 5), None);
    }

    #[test]
    fn pinned_session_changes_after_the_next_header_scrolls_past() {
        let sessions = [(true, 3), (false, 5), (true, 4)];

        assert_eq!(scroll_session_index(&sessions, 0), 0);
        assert_eq!(scroll_session_index(&sessions, 2), 0);
        assert_eq!(scroll_session_index(&sessions, 3), 0); // session 2 header
        assert_eq!(scroll_session_index(&sessions, 4), 0); // session 3 header
        assert_eq!(scroll_session_index(&sessions, 5), 2); // session 3 first card
    }

    #[test]
    fn memory_candidates_merge_across_blocks_without_losing_valid_results() {
        let output = |title: &str| {
            format!(
                "summary\n\n```contextos-json\n{{\"memory_candidates\":[{{\"kind\":\"todo\",\"title\":\"{title}\",\"content\":\"next\"}}]}}\n```"
            )
        };
        let outputs = vec![
            output("first"),
            "summary without json".to_string(),
            output("third"),
        ];

        let (candidates, warnings) = merge_chunk_memory_candidates(&outputs);

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].title, "first");
        assert_eq!(candidates[1].title, "third");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("第 2 块"));
    }

    #[test]
    fn packs_selected_turns_in_source_order_without_splitting() {
        let turns = vec![compressed(1, 4), compressed(2, 5), compressed(3, 4)];
        let selected = HashSet::from([3, 1]);

        let plan = pack_selected_turns(&turns, &selected, 8);

        assert!(plan.oversized_turns.is_empty());
        assert_eq!(plan.blocks.len(), 1);
        assert_eq!(plan.blocks[0].turn_numbers, vec![1, 3]);
        assert_eq!(plan.blocks[0].markdown.chars().count(), 8);
    }

    #[test]
    fn starts_a_new_block_before_the_next_complete_turn_exceeds_the_limit() {
        let turns = vec![compressed(1, 6), compressed(2, 5), compressed(3, 4)];
        let selected = HashSet::from([1, 2, 3]);

        let plan = pack_selected_turns(&turns, &selected, 10);

        assert_eq!(plan.blocks.len(), 2);
        assert_eq!(plan.blocks[0].turn_numbers, vec![1]);
        assert_eq!(plan.blocks[1].turn_numbers, vec![2, 3]);
    }

    #[test]
    fn reports_a_single_oversized_turn_instead_of_cutting_it() {
        let turns = vec![compressed(1, 11), compressed(2, 3)];
        let selected = HashSet::from([1, 2]);

        let plan = pack_selected_turns(&turns, &selected, 10);

        assert_eq!(plan.oversized_turns, vec![1]);
        assert_eq!(plan.blocks.len(), 1);
        assert_eq!(plan.blocks[0].turn_numbers, vec![2]);
        assert_eq!(plan.blocks[0].markdown, "xxx");
    }

    #[test]
    fn builds_each_turn_from_its_complete_rendered_fragment_before_counting() {
        let messages = vec![
            message(1, Role::User, "first request"),
            message(2, Role::Assistant, "first answer"),
            message(3, Role::User, "second request"),
        ];
        let turns = group_complete_turns(&messages);
        let mut seen = Vec::new();

        let compressed = build_compressed_turns(&turns, |fragment| {
            seen.push(fragment.to_string());
            Ok(format!("compressed:{}", fragment.chars().count()))
        })
        .expect("compression should succeed");

        assert_eq!(seen.len(), 2);
        assert!(seen[0].contains("first request"));
        assert!(seen[0].contains("first answer"));
        assert!(!seen[0].contains("second request"));
        assert!(compressed[0].display_content.contains("first request"));
        assert!(compressed[0].display_content.contains("first answer"));
        assert_eq!(compressed[1].display_content, "用户\nsecond request");
        assert!(compressed[0].markdown.starts_with("compressed:"));
    }

    #[test]
    fn assembles_block_results_without_a_second_llm_summary() {
        let turns = vec![compressed(1, 4), compressed(2, 4), compressed(3, 4)];
        let selected = HashSet::from([1, 2, 3]);
        let plan = pack_selected_turns(&turns, &selected, 8);
        let outputs = vec!["first summary".to_string(), "second summary".to_string()];

        let markdown = assemble_chunk_output("Long session", &plan.blocks, &outputs)
            .expect("matching output count");

        assert!(markdown.starts_with("# Long session - 分块压缩结果"));
        assert!(markdown.contains("## 块 1（第 1-2 轮，seq 10-29）"));
        assert!(markdown.contains("## 块 2（第 3 轮，seq 30-39）"));
        assert!(markdown.find("first summary") < markdown.find("second summary"));
    }

    #[test]
    fn assembly_lists_non_contiguous_manual_turns_explicitly() {
        let turns = vec![compressed(1, 4), compressed(2, 4), compressed(3, 4)];
        let selected = HashSet::from([1, 3]);
        let plan = pack_selected_turns(&turns, &selected, 8);

        let markdown = assemble_chunk_output("Manual", &plan.blocks, &["summary".to_string()])
            .expect("matching output count");

        assert!(markdown.contains("第 1、3 轮"), "{markdown}");
        assert!(!markdown.contains("第 1-3 轮"), "{markdown}");
    }
}
