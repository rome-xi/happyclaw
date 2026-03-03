interface TodoItem {
  id: string;
  content: string;
  status: string;
}

interface TodoProgressPanelProps {
  todos: TodoItem[];
}

export function TodoProgressPanel({ todos }: TodoProgressPanelProps) {
  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-3 mb-2">
      {/* Progress header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-primary">
          {completed}/{total} 已完成
        </span>
        <span className="text-xs text-muted-foreground">
          {Math.round(progress)}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-brand-100 rounded-full mb-2.5 overflow-hidden">
        <div
          className="h-full bg-brand-500 rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Todo items */}
      <div className="space-y-1">
        {todos.map((todo) => (
          <div key={todo.id} className="flex items-start gap-2 text-xs">
            <span className="flex-shrink-0 mt-0.5">
              {todo.status === 'completed' ? (
                <svg className="w-3.5 h-3.5 text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : todo.status === 'in_progress' ? (
                <svg className="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
            </span>
            <span className={`break-words ${
              todo.status === 'completed'
                ? 'text-muted-foreground line-through'
                : todo.status === 'in_progress'
                  ? 'text-primary font-medium'
                  : 'text-foreground'
            }`}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
