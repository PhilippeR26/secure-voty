import { create } from "zustand";

interface ChoiceState {
    choice: number | undefined,
    setChoice: (choice: number | undefined) => void, // undefined re-opens the form after a failed vote
    email: string | undefined,
    setEmail: (email: string) => void,
    userAuthorized: boolean,
    setUserAuthorized: (userAuthorized: boolean) => void,
}

export const useStoreChoice = create<ChoiceState>()(set => ({
    choice: undefined,
    setChoice: (choice: number | undefined) => { set(() => ({ choice })) },
    email: undefined,
    setEmail: (email: string) => { set(() => ({ email })) },
    userAuthorized: false,
    setUserAuthorized: (userAuthorized: boolean) => { set(() => ({ userAuthorized })) },
}));
