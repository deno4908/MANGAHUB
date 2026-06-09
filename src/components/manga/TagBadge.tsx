interface TagBadgeProps {
  tag: string;
  active?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
}

const TagBadge = ({ tag, active, onClick, onMouseEnter }: TagBadgeProps) => {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground'
      }`}
    >
      {tag}
    </button>
  );
};

export default TagBadge;
