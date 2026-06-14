/**
 * Computes the similarity score between two strings using Levenshtein Distance (Edit Distance).
 * Uses the Wagner-Fischer dynamic programming algorithm.
 * 
 * Returns a normalized score between 0.0 (completely different) and 1.0 (identical).
 * 
 * @param s1 The first string to compare.
 * @param s2 The second string to compare.
 */
export function stringSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;
  
  // Create a 2D grid to track the minimum edit distance at each prefix length
  const track = Array(s2.length + 1).fill(null).map(() =>
    Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
  for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;
  
  // Fill the dynamic programming matrix
  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1,             // Cost of deletion
        track[j - 1][i] + 1,             // Cost of insertion
        track[j - 1][i - 1] + indicator, // Cost of substitution
      );
    }
  }
  
  const maxLen = Math.max(s1.length, s2.length);
  return (maxLen - track[s2.length][s1.length]) / maxLen;
}

