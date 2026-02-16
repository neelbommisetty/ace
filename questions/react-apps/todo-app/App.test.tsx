import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

function getInput() {
  return (
    screen.queryByPlaceholderText(/add|what needs|new todo|todo/i) ??
    screen.getByRole('textbox')
  );
}

function getAddButton() {
  return screen.getByRole('button', { name: /add|submit/i });
}

describe('Todo App', () => {
  it('renders heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /todo app/i })).toBeInTheDocument();
  });

  it('can add a todo', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'Buy milk' } });
    fireEvent.click(addButton);
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
  });

  it('displays added todo', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'Walk the dog' } });
    fireEvent.click(addButton);
    expect(screen.getByText('Walk the dog')).toBeInTheDocument();
  });

  it('can toggle todo complete', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'Test todo' } });
    fireEvent.click(addButton);
    const checkbox =
      screen.getByText('Test todo').closest('li')?.querySelector('input[type="checkbox"]') ??
      screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('can delete a todo', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'Delete me' } });
    fireEvent.click(addButton);
    expect(screen.getByText('Delete me')).toBeInTheDocument();
    const deleteButton =
      screen.queryByRole('button', { name: /delete|remove|x/i }) ??
      screen.queryByLabelText(/delete|remove/i);
    if (!deleteButton) throw new Error('Delete button not found');
    fireEvent.click(deleteButton);
    expect(screen.queryByText('Delete me')).not.toBeInTheDocument();
  });

  it('filter shows only active todos', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'Active todo' } });
    fireEvent.click(addButton);
    fireEvent.change(input, { target: { value: 'Completed todo' } });
    fireEvent.click(addButton);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    const activeFilter =
      screen.queryByRole('button', { name: /active/i }) ?? screen.queryByText(/active/i);
    if (!activeFilter) throw new Error('Active filter not found');
    fireEvent.click(activeFilter);
    expect(screen.getByText('Active todo')).toBeInTheDocument();
    expect(screen.queryByText('Completed todo')).not.toBeInTheDocument();
  });

  it('filter shows only completed todos', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'Todo one' } });
    fireEvent.click(addButton);
    fireEvent.change(input, { target: { value: 'Todo two' } });
    fireEvent.click(addButton);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    const completedFilter =
      screen.queryByRole('button', { name: /completed/i }) ?? screen.queryByText(/completed/i);
    if (!completedFilter) throw new Error('Completed filter not found');
    fireEvent.click(completedFilter);
    expect(screen.getByText('Todo one')).toBeInTheDocument();
    expect(screen.queryByText('Todo two')).not.toBeInTheDocument();
  });

  it('shows remaining count', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.click(addButton);
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.click(addButton);
    const countEl =
      screen.queryByText(/2.*(item|remaining|left)/i) ?? screen.queryByText(/^2$/);
    expect(countEl).toBeInTheDocument();
  });

  it('can add multiple todos', () => {
    render(<App />);
    const input = getInput();
    const addButton = getAddButton();
    const todos = ['First todo', 'Second todo', 'Third todo'];
    todos.forEach((todo) => {
      fireEvent.change(input, { target: { value: todo } });
      fireEvent.click(addButton);
    });
    todos.forEach((todo) => {
      expect(screen.getByText(todo)).toBeInTheDocument();
    });
  });
});
