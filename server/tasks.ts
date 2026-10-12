export type Task = {
  id: string;
  title: string;
  blurb: string;
  source: string;
};

export const tasks: Task[] = [
  {
    id: "linear",
    title: "Линейный код",
    blurb: "Присваивания сверху вниз",
    source: `public class Linear {
    public static void main(String[] args) {
        int a = 2;
        int b = 5;
        int sum = a + b;
        System.out.println(sum);
    }
}`,
  },
  {
    id: "branch",
    title: "Ветвление",
    blurb: "Выполняется только взятая ветка",
    source: `public class MaxOfTwo {
    public static void main(String[] args) {
        int a = 4;
        int b = 9;
        int max;
        if (a > b) {
            max = a;
        } else {
            max = b;
        }
        System.out.println(max);
    }
}`,
  },
  {
    id: "loop",
    title: "Цикл",
    blurb: "Сначала i = 1, потом условие, после тела i++",
    source: `public class SumLoop {
    public static void main(String[] args) {
        int sum = 0;
        for (int i = 1; i <= 3; i++) {
            sum = sum + i;
        }
        System.out.println(sum);
    }
}`,
  },
  {
    id: "exprs",
    title: "Порядок вызовов",
    blurb: "Каждый square заходит в метод, потом add",
    source: `public class ExprOrder {
    static int square(int n) {
        return n * n;
    }

    static int add(int left, int right) {
        return left + right;
    }

    public static void main(String[] args) {
        int a = 2;
        int b = 3;
        int z = add(square(a), square(b));
        System.out.println(z);
    }
}`,
  },
  {
    id: "call",
    title: "Вызов метода",
    blurb: "Сначала вход в метод, потом возврат",
    source: `public class CallSquare {
    static int square(int n) {
        int result = n * n;
        return result;
    }

    public static void main(String[] args) {
        int x = 4;
        int y = square(x);
        System.out.println(y);
    }
}`,
  },
];

export function findTask(id: string): Task | undefined {
  return tasks.find((task) => task.id === id);
}
