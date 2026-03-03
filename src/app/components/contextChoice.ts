import { create } from "zustand";

interface ChoiceState {
    choice: number | undefined,
    setChoice: (choice: number) => void,
        email: string | undefined,
    setEmail: (email: string) => void,
    emailOK: boolean,
    setEmailOK: (emailOK: boolean) => void,
}

export const useStoreChoice = create<ChoiceState>()(set => ({
    choice: undefined,
    setChoice: (choice: number) => { set(() => ({ choice })) },
    email: undefined,
    setEmail: (email: string) => { set(() => ({ email })) },
    emailOK: false,
    setEmailOK: (emailOK: boolean) => { set(() => ({ emailOK })) },
}));
