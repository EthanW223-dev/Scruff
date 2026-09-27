namespace Scruff
{
    public static class NameGenerator
    {
        static readonly string[] First =
        {
            "Kyle", "Tasha", "Dmitri", "Rosa", "Benny", "Marcus", "Jolene", "Tyrese", "Wendy", "Ricky", "Priya", "Chad",
            "Lou", "Imani", "Gus", "Deb", "Hector", "Mei", "Otis", "Sal", "Tamika", "Vince", "Bree", "Nando",
        };

        static readonly string[] Last =
        {
            "Moss", "Pike", "Vargas", "Kowalski", "Reyes", "Duncan", "Okafor", "Briggs", "Nguyen", "Hale", "Ferreira", "Stubbs",
        };

        public static string Make(System.Random rng, System.Collections.Generic.ICollection<string> taken = null)
        {
            for (int i = 0; i < 40; i++)
            {
                string n = First[rng.Next(First.Length)];
                if (taken == null || !taken.Contains(n)) return n;
            }
            return First[rng.Next(First.Length)] + " " + Last[rng.Next(Last.Length)][0] + ".";
        }
    }
}
