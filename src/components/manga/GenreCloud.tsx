import { useCategories } from '@/hooks/useApi';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { memo } from 'react';
import { Loader2 } from 'lucide-react';

const GenreCloud = () => {
  const { data: categories = [], isLoading } = useCategories();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="home-genre-cloud flex flex-wrap gap-1.5">
      {categories.map((cat, i) => (
        <motion.div
          key={cat.slug}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.02 }}
          whileHover={{ scale: 1.05 }}
        >
          <Link
            to={`/manga?genre=${encodeURIComponent(cat.slug)}${cat.source === 'mangadex' ? '&source=mangadex' : ''}`}
            className="tag-pill"
          >
            {cat.name}
          </Link>
        </motion.div>
      ))}
    </div>
  );
};

export default memo(GenreCloud);
